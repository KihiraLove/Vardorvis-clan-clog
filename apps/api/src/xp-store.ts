/** Transactional snapshots; retries survive process restarts and preview expiry. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ApiError } from './types.js';
import {
  diffTotals,
  revisionFor,
  sumTotals,
  type XpApply,
  type XpChange,
  type XpEvent,
  type XpPreview,
  type XpSnapshot,
  type XpStore,
} from './xp-types.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const maxEvents = 2000;
function requireCapacity(count: number, existing: boolean) {
  if (!existing && count >= maxEvents)
    throw new ApiError(
      409,
      'The XP tracker has reached its 2000-event capacity. Existing events can still be refreshed.',
    );
}
type Row = {
  competition_id: string;
  title: string;
  source_url: string;
  skills: XpEvent['skills'];
  gains: XpEvent['gains'];
  source_hash: string;
  source_snapshot: XpSnapshot;
};
const event = (row: Row): XpEvent => ({
  id: Number(row.competition_id),
  title: row.title,
  sourceUrl: row.source_url,
  skills: row.skills,
  gains: row.gains,
});
export class PgXpStore implements XpStore {
  constructor(private readonly pool: pg.Pool) {}
  private async state(client: pg.PoolClient, lock = false) {
    const row = (
      await client.query<{ version: string }>(
        'SELECT version::text AS version FROM xp_state WHERE singleton=true' +
          (lock ? ' FOR UPDATE' : ''),
      )
    ).rows[0];
    if (!row) throw new ApiError(503, 'XP state unavailable.');
    return revisionFor(row.version);
  }
  private async events(client: pg.PoolClient): Promise<Row[]> {
    const rows = (
      await client.query<Row>(
        'SELECT competition_id::text,title,source_url,skills,gains,source_hash,source_snapshot FROM xp_events ORDER BY competition_id LIMIT $1',
        [maxEvents + 1],
      )
    ).rows;
    if (rows.length > maxEvents)
      throw new ApiError(503, 'XP event limit exceeded.');
    return rows;
  }
  async tracker() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const revision = await this.state(client);
      const events = (await this.events(client)).map(event);
      const totals = sumTotals(events);
      await client.query('COMMIT');
      return { revision, totals, events };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async preview(snapshot: XpSnapshot, actor: string): Promise<XpPreview> {
    const client = await this.pool.connect(),
      token = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const expectedRevision = await this.state(client);
      const events = await this.events(client);
      const prior =
        events.find((x) => Number(x.competition_id) === snapshot.event.id) ??
        null;
      requireCapacity(events.length, !!prior);
      if (
        prior &&
        JSON.stringify(prior.skills) !== JSON.stringify(snapshot.event.skills)
      )
        throw new ApiError(
          422,
          'WOM competition skill scope changed; manual reconciliation is required.',
        );
      const changes = diffTotals(
        sumTotals(events.map(event)),
        prior ? event(prior) : null,
        snapshot.event,
      );
      const expiresAt = new Date(Date.now() + 600000).toISOString();
      await client.query(
        'INSERT INTO xp_previews(token_hash,actor_discord_id,expected_revision,snapshot,expires_at) VALUES($1,$2,$3,$4,$5)',
        [
          hash(token),
          actor,
          expectedRevision,
          JSON.stringify(snapshot),
          expiresAt,
        ],
      );
      await client.query('COMMIT');
      const oldPlayers =
        prior?.source_snapshot.participants.map((p) => p.playerId) ?? [];
      const currentPlayers = snapshot.participants.map((p) => p.playerId);
      const warnings: string[] = [];
      if (changes.some((x) => BigInt(x.change) < 0n))
        warnings.push(
          'This correction reduces previously recorded XP. Review it before applying.',
        );
      if (
        prior &&
        (oldPlayers.length !== currentPlayers.length ||
          oldPlayers.some((id) => !currentPlayers.includes(id)))
      )
        warnings.push(
          'The competition participant roster changed. Review the reconciliation.',
        );
      if (events.some((x) => Number(x.competition_id) !== snapshot.event.id))
        warnings.push(
          'Other events may overlap this competition; their gains are counted independently.',
        );
      return {
        previewToken: token,
        expectedRevision,
        expiresAt,
        competition: {
          id: snapshot.event.id,
          title: snapshot.event.title,
          sourceUrl: snapshot.event.sourceUrl,
          skills: snapshot.event.skills,
          startsAt: snapshot.startsAt,
          endsAt: snapshot.endsAt,
          importedAt: new Date().toISOString(),
        },
        participants: snapshot.participants,
        changes,
        warnings,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async apply(
    token: string,
    revision: string,
    key: string,
    actor: string,
    actorName: string,
    acknowledgeCorrections: boolean,
  ): Promise<XpApply> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock before checking idempotency to serialize simultaneous applications.
      const current = await this.state(client, true);
      const replay = (
        await client.query<{
          token_hash: string;
          expected_revision: string;
          resulting_revision: string;
          outcome: XpApply['outcome'];
          acknowledged_corrections: boolean;
        }>(
          'SELECT token_hash,expected_revision,resulting_revision,outcome,acknowledged_corrections FROM xp_import_history WHERE actor_discord_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.token_hash !== hash(token) ||
          replay.expected_revision !== revision ||
          replay.acknowledged_corrections !== acknowledgeCorrections
        )
          throw new ApiError(
            409,
            'Import key already used for a different request.',
          );
        await client.query('COMMIT');
        return { outcome: replay.outcome, revision: replay.resulting_revision };
      }
      const row = (
        await client.query<{
          actor_discord_id: string;
          expected_revision: string;
          snapshot: XpSnapshot;
          expires_at: Date;
        }>(
          'SELECT actor_discord_id,expected_revision,snapshot,expires_at FROM xp_previews WHERE token_hash=$1',
          [hash(token)],
        )
      ).rows[0];
      if (
        !row ||
        row.actor_discord_id !== actor ||
        row.expires_at.getTime() <= Date.now()
      )
        throw new ApiError(
          409,
          'Preview expired or belongs to another administrator.',
        );
      if (row.expected_revision !== revision || current !== revision)
        throw new ApiError(409, 'XP tracker changed; preview again.');
      const all = await this.events(client);
      const prior =
        all.find((x) => Number(x.competition_id) === row.snapshot.event.id) ??
        null;
      // The state lock serializes consumption of the final slot; replays return above.
      requireCapacity(all.length, !!prior);
      const changes = diffTotals(
        sumTotals(all.map(event)),
        prior ? event(prior) : null,
        row.snapshot.event,
      );
      if (changes.some((x) => BigInt(x.change) < 0n) && !acknowledgeCorrections)
        throw new ApiError(
          422,
          'Acknowledge negative XP corrections before applying.',
        );
      const changed = !prior || prior.source_hash !== row.snapshot.sourceHash;
      if (changed) {
        await client.query(
          'INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot,imported_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(competition_id) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,skills=EXCLUDED.skills,gains=EXCLUDED.gains,source_hash=EXCLUDED.source_hash,source_snapshot=EXCLUDED.source_snapshot,imported_at=now()',
          [
            row.snapshot.event.id,
            row.snapshot.event.title,
            row.snapshot.event.sourceUrl,
            JSON.stringify(row.snapshot.event.skills),
            JSON.stringify(row.snapshot.event.gains),
            row.snapshot.sourceHash,
            JSON.stringify(row.snapshot),
          ],
        );
        await client.query(
          'UPDATE xp_state SET version=version+1,updated_at=now() WHERE singleton=true',
        );
      }
      const nextRevision = changed
        ? revisionFor((BigInt(current.slice(3)) + 1n).toString())
        : current;
      const outcome = changed ? 'applied' : 'unchanged';
      await client.query(
        'INSERT INTO xp_import_history(id,actor_discord_id,actor_name,request_key,token_hash,expected_revision,competition_id,title,outcome,changes,resulting_revision,acknowledged_corrections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          randomUUID(),
          actor,
          actorName,
          key,
          hash(token),
          revision,
          row.snapshot.event.id,
          row.snapshot.event.title,
          outcome,
          JSON.stringify(changes),
          nextRevision,
          acknowledgeCorrections,
        ],
      );
      await client.query('COMMIT');
      return { outcome, revision: nextRevision };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async history() {
    const rows = (
      await this.pool.query<{
        id: string;
        competition_id: string;
        title: string;
        actor_name: string;
        imported_at: Date;
        outcome: 'applied' | 'unchanged';
        changes: XpChange[];
      }>(
        'SELECT id::text,competition_id::text,title,actor_name,imported_at,outcome,changes FROM xp_import_history ORDER BY imported_at DESC,id DESC LIMIT 2001',
      )
    ).rows;
    if (rows.length > 2000)
      throw new ApiError(503, 'XP history requires pagination.');
    return {
      imports: rows.map((row) => ({
        id: row.id,
        competitionId: Number(row.competition_id),
        title: row.title,
        actorName: row.actor_name,
        importedAt: row.imported_at.toISOString(),
        outcome: row.outcome,
        changes: row.changes,
      })),
    };
  }
}

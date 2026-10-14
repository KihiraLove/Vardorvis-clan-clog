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
  type PodiumPlayer,
} from './xp-types.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const maxEvents = 2000;
export function requireXpCapacity(count: number, existing: boolean) {
  if (!existing && count >= maxEvents)
    throw new ApiError(
      409,
      'The XP tracker has reached its 2000-event capacity. Existing events can still be refreshed.',
    );
}
type HistoryKey = { at: string; id: string };
const historyCursor = (
  revision: string,
  limit: number,
  key: HistoryKey | null,
) =>
  Buffer.from(JSON.stringify({ revision, limit, key })).toString('base64url');
function readHistoryCursor(
  cursor: string | undefined,
  revision: string,
  limit: number,
): HistoryKey | null {
  if (cursor === undefined) return null;
  const expired = () =>
    new ApiError(
      409,
      'XP import history changed or cursor expired. Reload the first page.',
    );
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor))
      throw expired();
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { revision?: unknown; limit?: unknown; key?: HistoryKey | null };
    if (!value || value.revision !== revision || value.limit !== limit)
      throw expired();
    const key = value.key;
    if (key === null) return null;
    if (
      !key ||
      typeof key.at !== 'string' ||
      key.at.startsWith('0000-') ||
      typeof key.id !== 'string' ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(
        key.at,
      ) ||
      !Number.isFinite(Date.parse(key.at)) ||
      new Date(key.at).toISOString() !== key.at.slice(0, 23) + 'Z' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        key.id,
      )
    )
      throw expired();
    return key;
  } catch {
    throw expired();
  }
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
      const rows = await this.events(client);
      const totals = sumTotals(rows.map(event));
      const currentMetadata = (
        await client.query<{
          id: number;
          title: string;
          sourceUrl: string;
          skills: XpEvent['skills'];
        }>(
          'SELECT competition_id::float8 AS id,title,source_url AS "sourceUrl",skills FROM wom_competitions WHERE kind=\'SKILL\' AND archived_at IS NULL ORDER BY ends_at DESC,competition_id DESC LIMIT 2001',
        )
      ).rows;
      if (currentMetadata.length > maxEvents)
        throw new ApiError(503, 'XP event limit exceeded.');
      // Archived contributions stay in all-time totals and event browsing. Both
      // branches are independently bounded; archived metadata without XP is paged separately.
      const archivedMetadata = (
        await client.query<{
          id: number;
          title: string;
          sourceUrl: string;
          skills: XpEvent['skills'];
        }>(
          'SELECT c.competition_id::float8 AS id,c.title,c.source_url AS "sourceUrl",c.skills FROM (SELECT competition_id FROM xp_events ORDER BY competition_id LIMIT 2001) e CROSS JOIN LATERAL (SELECT competition_id,title,source_url,skills,ends_at FROM wom_competitions WHERE competition_id=e.competition_id AND archived_at IS NOT NULL LIMIT 1) c ORDER BY c.ends_at DESC,c.competition_id DESC LIMIT 2001',
        )
      ).rows;
      if (archivedMetadata.length > maxEvents)
        throw new ApiError(503, 'XP event limit exceeded.');
      const metadata = [...currentMetadata, ...archivedMetadata];
      const totalPlayers = new Map<number, PodiumPlayer>();
      // Name snapshots follow the latest successful import; stable ID breaks timestamp ties.
      const imported = (
        await client.query<{ competition_id: string }>(
          'SELECT competition_id::text FROM xp_events ORDER BY imported_at,competition_id LIMIT 2001',
        )
      ).rows;
      for (const item of imported) {
        const source = rows.find(
          (r) => r.competition_id === item.competition_id,
        );
        if (!source) continue;
        for (const p of source.source_snapshot.participants) {
          const gained = Object.values(p.gains).reduce(
            (sum, n) => sum + BigInt(n!),
            0n,
          );
          if (gained <= 0n) continue;
          const prior = totalPlayers.get(p.playerId);
          totalPlayers.set(p.playerId, {
            playerId: p.playerId,
            displayName: p.displayName,
            gained: (BigInt(prior?.gained ?? '0') + gained).toString(),
          });
        }
      }
      const events = metadata.map((m) => {
        const r = rows.find((r) => Number(r.competition_id) === m.id);
        return {
          ...m,
          gains: r?.gains ?? Object.fromEntries(m.skills.map((s) => [s, null])),
          podium: r
            ? rankPodium(
                r.source_snapshot.participants.map((p) => ({
                  playerId: p.playerId,
                  displayName: p.displayName,
                  gained: Object.values(p.gains)
                    .reduce((sum, n) => sum + BigInt(n!), 0n)
                    .toString(),
                })),
              )
            : [],
        };
      });
      const podium = rankPodium([...totalPlayers.values()]);
      await client.query('COMMIT');
      return { revision, totals, events, podium };
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
      await requireFinishedSkill(client, snapshot);
      const expectedRevision = await this.state(client);
      const events = await this.events(client);
      const prior =
        events.find((x) => Number(x.competition_id) === snapshot.event.id) ??
        null;
      requireXpCapacity(events.length, !!prior);
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
          'SELECT actor_discord_id,expected_revision,snapshot,expires_at FROM xp_previews WHERE token_hash=$1 FOR KEY SHARE',
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
      await requireFinishedSkill(client, row.snapshot);
      const prior =
        all.find((x) => Number(x.competition_id) === row.snapshot.event.id) ??
        null;
      // The state lock serializes consumption of the final slot; replays return above.
      requireXpCapacity(all.length, !!prior);
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
        await saveLegacyIdentity(client, row.snapshot);
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
  async history(cursor?: string, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new ApiError(400, 'Page size must be between 1 and 20.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const state = (
        await client.query<{ version: string }>(
          'SELECT history_version::text AS version FROM xp_state WHERE singleton',
        )
      ).rows[0];
      if (!state) throw new ApiError(503, 'XP history state unavailable.');
      const revision = 'xp-history-' + state.version;
      const key = readHistoryCursor(cursor, revision, limit);
      const rows = (
        await client.query<{
          id: string;
          competition_id: string;
          title: string;
          actor_name: string;
          imported_at: Date;
          pageTime: string;
          outcome: 'applied' | 'unchanged';
          changes: XpChange[];
        }>(
          'SELECT id::text,competition_id::text,title,actor_name,imported_at,outcome,changes,' +
            'to_char(imported_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS "pageTime" ' +
            'FROM xp_import_history ' +
            (key
              ? 'WHERE (imported_at,id) < ($2::timestamptz,$3::uuid) '
              : '') +
            'ORDER BY xp_import_history.imported_at DESC,xp_import_history.id DESC LIMIT $1',
          key ? [limit + 1, key.at, key.id] : [limit + 1],
        )
      ).rows;
      const page = rows.slice(0, limit),
        last = page.at(-1);
      await client.query('COMMIT');
      return {
        revision,
        pageCursor: historyCursor(revision, limit, key),
        nextCursor:
          rows.length > limit && last
            ? historyCursor(revision, limit, { at: last.pageTime, id: last.id })
            : null,
        imports: page.map((row) => ({
          id: row.id,
          competitionId: Number(row.competition_id),
          title: row.title,
          actorName: row.actor_name,
          importedAt: row.imported_at.toISOString(),
          outcome: row.outcome,
          changes: row.changes,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function requireFinishedSkill(
  client: pg.PoolClient,
  snapshot: XpSnapshot,
) {
  const row = (
    await client.query<{
      kind: string;
      skills: XpEvent['skills'];
      archived_at: Date | null;
    }>(
      'SELECT kind,skills,archived_at FROM wom_competitions WHERE competition_id=$1',
      [snapshot.event.id],
    )
  ).rows[0];
  if (row?.archived_at)
    throw new ApiError(
      409,
      'Competition is archived. Restore it before importing again.',
    );
  if (row && row.kind !== 'SKILL')
    throw new ApiError(
      422,
      'This WOM identity is already an ACTIVITY competition.',
    );
  if (
    row &&
    JSON.stringify(row.skills) !== JSON.stringify(snapshot.event.skills)
  )
    throw new ApiError(
      422,
      'WOM competition skill scope changed; manual reconciliation is required.',
    );
  requireXpCapacity(
    (
      await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM (SELECT 1 FROM wom_competitions WHERE archived_at IS NULL LIMIT 2000) slots',
      )
    ).rows[0]!.count,
    !!row,
  );
  if (
    !(
      await client.query(
        'SELECT 1 WHERE $1::timestamptz <= clock_timestamp()',
        [snapshot.endsAt],
      )
    ).rowCount
  )
    throw new ApiError(
      422,
      'Use the competition schedule importer for future or running competitions. XP results are imported only after the end.',
    );
}
export function rankPodium(players: PodiumPlayer[]): PodiumPlayer[] {
  return players
    .filter((p) => BigInt(p.gained) > 0n)
    .sort((a, b) =>
      BigInt(a.gained) > BigInt(b.gained)
        ? -1
        : BigInt(a.gained) < BigInt(b.gained)
          ? 1
          : a.playerId - b.playerId,
    )
    .slice(0, 3);
}
async function saveLegacyIdentity(client: pg.PoolClient, snapshot: XpSnapshot) {
  await client.query(
    "INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,results_imported_at,source_hash) VALUES($1,'SKILL',$2,$3,$4,$4,$5,$6,now(),$7) ON CONFLICT(competition_id) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,results_imported_at=now(),source_hash=EXCLUDED.source_hash",
    [
      snapshot.event.id,
      snapshot.event.title,
      snapshot.event.sourceUrl,
      JSON.stringify(snapshot.event.skills),
      snapshot.startsAt,
      snapshot.endsAt,
      snapshot.sourceHash,
    ],
  );
}

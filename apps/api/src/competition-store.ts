import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  competitionImportAction,
  competitionLifecycle,
  type WomCompetition,
} from '@clog/domain';
import { ApiError } from './types.js';
import { readState } from './scheduling-store.js';
import { competitionHash, mappedPages } from './competition-wom.js';
import { diffTotals, sumTotals, type XpEvent } from './xp-types.js';
import type {
  CompetitionPreview,
  CompetitionReceipt,
  CompetitionSnapshot,
} from './competition-types.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Stored = WomCompetition & {
  skills: string[];
  scheduleId: string | null;
  scheduleCreated: boolean;
  sourceHash: string | null;
  resultsImportedAt: Date | null;
};
async function stored(
  client: pg.PoolClient,
  id: number,
): Promise<Stored | undefined> {
  const row = (
    await client.query<Stored & { startsAt: Date; endsAt: Date }>(
      'SELECT competition_id::float8 AS id,kind,title,source_url AS "sourceUrl",metrics,skills,starts_at AS "startsAt",ends_at AS "endsAt",schedule_id AS "scheduleId",schedule_created AS "scheduleCreated",source_hash AS "sourceHash",results_imported_at AS "resultsImportedAt" FROM wom_competitions WHERE competition_id=$1',
      [id],
    )
  ).rows[0];
  return row
    ? {
        ...row,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
      }
    : undefined;
}
function requireScope(
  prior: Stored | undefined,
  snapshot: CompetitionSnapshot,
) {
  if (!prior) return;
  if (prior.kind !== snapshot.competition.kind)
    throw new ApiError(
      422,
      'This WOM competition already has a different kind. Its identity cannot be duplicated.',
    );
  const old = prior.kind === 'SKILL' ? prior.skills : prior.metrics;
  const next =
    prior.kind === 'SKILL' ? snapshot.skills : snapshot.competition.metrics;
  if (JSON.stringify(old) !== JSON.stringify(next))
    throw new ApiError(
      422,
      'WOM metric scope changed; manual reconciliation is required.',
    );
  if (prior.resultsImportedAt && snapshot.lifecycle !== 'finished')
    throw new ApiError(
      422,
      'A finalized competition cannot be replaced with live metadata.',
    );
}
async function xpEvents(client: pg.PoolClient): Promise<XpEvent[]> {
  return (
    await client.query<XpEvent>(
      'SELECT e.competition_id::float8 AS id,e.title,e.source_url AS "sourceUrl",e.skills,e.gains FROM xp_events e JOIN wom_competitions c USING(competition_id) WHERE c.kind=\'SKILL\' ORDER BY e.competition_id',
    )
  ).rows;
}
export class PgCompetitionStore {
  constructor(private readonly pool: pg.Pool) {}
  async clock(): Promise<number> {
    return (
      await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
  }
  async activities() {
    const rows = (
      await this.pool.query<WomCompetition & { startsAt: Date; endsAt: Date }>(
        'SELECT competition_id::float8 AS id,kind,title,source_url AS "sourceUrl",metrics,starts_at AS "startsAt",ends_at AS "endsAt" FROM wom_competitions WHERE kind=\'ACTIVITY\' ORDER BY ends_at DESC,competition_id DESC LIMIT 2001',
      )
    ).rows;
    if (rows.length > 2000)
      throw new ApiError(503, 'Competition listing exceeds supported limits.');
    return {
      serverNow: new Date(await this.clock()).toISOString(),
      competitions: rows.map((r) => ({
        ...r,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
      })),
    };
  }
  async preview(
    snapshot: CompetitionSnapshot,
    actor: string,
    pageIds?: string[],
  ): Promise<CompetitionPreview> {
    const client = await this.pool.connect();
    const token = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const now = (
        await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now;
      const lifecycle = competitionLifecycle(
        snapshot.competition,
        now.getTime(),
      );
      if (lifecycle === 'finished' && !snapshot.results)
        throw new ApiError(
          409,
          'Competition finished during fetch. Preview again to import final results.',
        );
      if (lifecycle !== 'finished' && snapshot.results)
        throw new ApiError(
          409,
          'Competition time state changed. Preview again.',
        );
      snapshot = { ...snapshot, lifecycle };
      const skill = snapshot.competition.kind === 'SKILL';
      if (skill && pageIds?.length)
        throw new ApiError(
          422,
          'SKILL imports do not open collection log pages. Import the competition metadata without page selections.',
        );
      const prior = await stored(client, snapshot.competition.id);
      requireScope(prior, snapshot);
      const schedules = await readState(client);
      const revision =
        'xp-' +
        (
          await client.query<{ version: string }>(
            'SELECT version::text FROM xp_state WHERE singleton=true',
          )
        ).rows[0]!.version;
      const count = (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM wom_competitions',
        )
      ).rows[0]!.count;
      if (!prior && count >= 2000)
        throw new ApiError(
          409,
          'Competition capacity reached; existing competitions can still be refreshed.',
        );
      const pages = skill
        ? []
        : (
            await client.query<{ id: string; name: string }>(
              'SELECT id,name FROM pages WHERE active ORDER BY category,sort_order,id',
            )
          ).rows;
      const proposed = [
        ...new Set(snapshot.competition.metrics.flatMap(mappedPages)),
      ].filter((id) => pages.some((p) => p.id === id));
      const linked = schedules.schedules.find(
        (s) => s.id === prior?.scheduleId,
      );
      const selected =
        skill || lifecycle === 'finished'
          ? []
          : (linked?.pageIds ?? pageIds ?? proposed);
      if (
        selected.length > 200 ||
        new Set(selected).size !== selected.length ||
        (!prior?.scheduleCreated &&
          lifecycle !== 'finished' &&
          selected.some((id) => !pages.some((p) => p.id === id)))
      )
        throw new ApiError(422, 'Choose distinct active collection log pages.');
      const action = competitionImportAction(
        snapshot.competition.kind,
        lifecycle,
        prior?.scheduleCreated,
        !!linked,
      );
      const events = await xpEvents(client);
      const changes = snapshot.results?.xp
        ? diffTotals(
            sumTotals(events),
            events.find((e) => e.id === snapshot.competition.id) ?? null,
            snapshot.results.xp.event,
          )
        : [];
      const expiresAt = new Date(now.getTime() + 600000).toISOString();
      await client.query(
        'INSERT INTO competition_previews(token_hash,actor_id,expected_revision,schedule_revision,snapshot,page_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          hash(token),
          actor,
          revision,
          schedules.revision,
          JSON.stringify(snapshot),
          selected,
          expiresAt,
        ],
      );
      await client.query('COMMIT');
      const warnings: string[] = [];
      if (skill && prior?.scheduleCreated)
        warnings.push(
          linked
            ? 'The previously linked staff schedule is preserved. This SKILL import will not edit or open pages; manage that schedule in Scheduling.'
            : 'The previously linked schedule was deleted. This SKILL import will not recreate it.',
        );
      if (
        snapshot.competition.metrics
          .flatMap(mappedPages)
          .some((id) => !pages.some((p) => p.id === id))
      )
        warnings.push(
          'Some mapped pages are unavailable. Review the active page selections before applying.',
        );
      if (action === 'preserve-schedule')
        warnings.push(
          'The existing linked schedule and staff edits will be preserved. Edit its window in Scheduling.',
        );
      if (action === 'preserve-deletion')
        warnings.push(
          'The linked schedule was deleted by staff. Importing again will preserve that deletion. Create a manual schedule to reopen pages.',
        );
      if (action === 'create-schedule' && !selected.length)
        warnings.push(
          'Choose at least one active page before applying. This metric has no automatic page mapping.',
        );
      if (!skill && !schedules.enabled && lifecycle !== 'finished')
        warnings.push(
          'Scheduling is disabled. This import will not enable enforcement.',
        );
      if (changes.some((c) => BigInt(c.change) < 0n))
        warnings.push(
          'This correction reduces recorded XP and requires acknowledgement.',
        );
      if (
        snapshot.results?.xp &&
        events.some((e) => e.id !== snapshot.competition.id)
      )
        warnings.push(
          'Overlapping competitions count their reported XP independently.',
        );
      return {
        previewToken: token,
        expectedRevision: revision,
        scheduleRevision: schedules.revision,
        expiresAt,
        competition: snapshot.competition,
        lifecycle,
        pageIds: selected,
        pages,
        action,
        scheduleStartsAt:
          skill || lifecycle === 'finished'
            ? null
            : (linked?.startsAt ??
              (lifecycle === 'running'
                ? now.toISOString()
                : snapshot.competition.startsAt)),
        participants:
          snapshot.results?.xp?.participants ??
          snapshot.results?.participants ??
          [],
        changes,
        warnings,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async apply(
    token: string,
    revision: string,
    scheduleRevision: string,
    key: string,
    actor: string,
    actorName: string,
    role: 'admin' | 'moderator',
    acknowledgeCorrections: boolean,
  ): Promise<CompetitionReceipt> {
    const client = await this.pool.connect();
    const requestHash = competitionHash({
      token,
      revision,
      scheduleRevision,
      acknowledgeCorrections,
    });
    try {
      await client.query('BEGIN');
      // Scheduling settings always precede XP state, competition and page locks.
      await client.query(
        'SELECT singleton FROM collection_scheduling WHERE singleton=true FOR UPDATE',
      );
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM xp_state WHERE singleton=true FOR UPDATE',
        )
      ).rows[0]!;
      const replay = (
        await client.query<{
          request_hash: string;
          receipt: CompetitionReceipt;
          kind: string;
          new_values: { lifecycle: string };
        }>(
          'SELECT request_hash,receipt,kind,new_values FROM competition_import_history WHERE actor_id=$1 AND request_key=$2',
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw new ApiError(
            409,
            'Import key already used for a different request.',
          );
        if (
          role !== 'admin' &&
          replay.kind === 'SKILL' &&
          replay.new_values.lifecycle === 'finished'
        )
          throw new ApiError(
            403,
            'Only the administrator can import XP results.',
          );
        await client.query('COMMIT');
        return replay.receipt;
      }
      const row = (
        await client.query<{
          actor_id: string;
          expected_revision: string;
          schedule_revision: string;
          snapshot: CompetitionSnapshot;
          page_ids: string[];
          expires_at: Date;
        }>(
          'SELECT * FROM competition_previews WHERE token_hash=$1 FOR KEY SHARE',
          [hash(token)],
        )
      ).rows[0];
      const now = (
        await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now;
      if (!row || row.actor_id !== actor || row.expires_at <= now)
        throw new ApiError(
          409,
          'Preview expired or belongs to another staff member.',
        );
      const schedules = await readState(client);
      if (
        revision !== row.expected_revision ||
        revision !== 'xp-' + state.version ||
        scheduleRevision !== row.schedule_revision ||
        scheduleRevision !== schedules.revision
      )
        throw new ApiError(
          409,
          'Competitions or schedules changed. Preview again.',
        );
      const snapshot = row.snapshot,
        c = snapshot.competition;
      if (c.kind === 'SKILL' && row.page_ids.length)
        throw new ApiError(
          409,
          'SKILL import behavior changed. Preview again to import without opening pages.',
        );
      const lifecycle = competitionLifecycle(c, now.getTime());
      if ((lifecycle === 'finished') !== !!snapshot.results)
        throw new ApiError(
          409,
          'Competition changed time state. Preview again to fetch final results.',
        );
      if (role !== 'admin' && c.kind === 'SKILL' && lifecycle === 'finished')
        throw new ApiError(
          403,
          'Only the administrator can import XP results.',
        );
      const prior = await stored(client, c.id);
      requireScope(prior, { ...snapshot, lifecycle });
      if (
        !prior &&
        (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM wom_competitions',
          )
        ).rows[0]!.count >= 2000
      )
        throw new ApiError(409, 'Competition capacity reached.');
      let scheduleId = prior?.scheduleId ?? null;
      const action = competitionImportAction(
        c.kind,
        lifecycle,
        prior?.scheduleCreated,
        schedules.schedules.some((s) => s.id === scheduleId),
      );
      const createSchedule = action === 'create-schedule';
      if (createSchedule) {
        if (!row.page_ids.length || row.page_ids.length > 200)
          throw new ApiError(
            422,
            'Choose at least one active collection log page.',
          );
        if (schedules.schedules.length >= 500)
          throw new ApiError(422, 'The schedule limit has been reached.');
        const pages = await client.query(
          'SELECT id FROM pages WHERE id=ANY($1::text[]) AND active ORDER BY id FOR SHARE',
          [row.page_ids],
        );
        if (pages.rowCount !== row.page_ids.length)
          throw new ApiError(422, 'Choose active collection log pages.');
        scheduleId = randomUUID();
        await client.query(
          'INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES($1,$2,$3,$4)',
          [
            scheduleId,
            c.title.slice(0, 100),
            lifecycle === 'running' ? now.toISOString() : c.startsAt,
            c.endsAt,
          ],
        );
        await client.query(
          'INSERT INTO collection_log_schedule_pages(schedule_id,page_id) SELECT $1,unnest($2::text[])',
          [scheduleId, row.page_ids],
        );
        const version = (
          await client.query<{ version: number }>(
            'UPDATE collection_scheduling SET version=version+1 WHERE singleton=true RETURNING version',
          )
        ).rows[0]!.version;
        const after = await readState(client);
        await client.query(
          "INSERT INTO collection_schedule_audit(actor_id,actor_name,action,version,old_values,new_values) VALUES($1,$2,'create',$3,$4,$5)",
          [
            actor,
            actorName,
            version,
            JSON.stringify(schedules),
            JSON.stringify(after),
          ],
        );
      }
      const sourceHash =
        snapshot.results?.xp?.sourceHash ??
        competitionHash({
          competition: c,
          skills: snapshot.skills,
          results: snapshot.results,
        });
      const changed =
        !prior || prior.sourceHash !== sourceHash || createSchedule;
      const events = await xpEvents(client);
      const xp = snapshot.results?.xp;
      const changes = xp
        ? diffTotals(
            sumTotals(events),
            events.find((e) => e.id === c.id) ?? null,
            xp.event,
          )
        : [];
      if (changes.some((v) => BigInt(v.change) < 0n) && !acknowledgeCorrections)
        throw new ApiError(
          422,
          'Acknowledge negative XP corrections before applying.',
        );
      if (changed) {
        await client.query(
          'INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,schedule_id,schedule_created,results_imported_at,activity_results,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(competition_id) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,metrics=EXCLUDED.metrics,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,schedule_id=EXCLUDED.schedule_id,schedule_created=EXCLUDED.schedule_created,results_imported_at=EXCLUDED.results_imported_at,activity_results=EXCLUDED.activity_results,source_hash=EXCLUDED.source_hash',
          [
            c.id,
            c.kind,
            c.title,
            c.sourceUrl,
            JSON.stringify(c.metrics),
            JSON.stringify(snapshot.skills),
            c.startsAt,
            c.endsAt,
            scheduleId,
            prior?.scheduleCreated || createSchedule,
            xp || snapshot.results ? now.toISOString() : null,
            c.kind === 'ACTIVITY' && snapshot.results
              ? JSON.stringify(snapshot.results.participants)
              : null,
            sourceHash,
          ],
        );
        if (xp)
          await client.query(
            'INSERT INTO xp_events(competition_id,title,source_url,skills,gains,source_hash,source_snapshot,imported_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(competition_id) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,skills=EXCLUDED.skills,gains=EXCLUDED.gains,source_hash=EXCLUDED.source_hash,source_snapshot=EXCLUDED.source_snapshot,imported_at=EXCLUDED.imported_at',
            [
              c.id,
              c.title,
              c.sourceUrl,
              JSON.stringify(xp.event.skills),
              JSON.stringify(xp.event.gains),
              xp.sourceHash,
              JSON.stringify(xp),
              now.toISOString(),
            ],
          );
        await client.query(
          'UPDATE xp_state SET version=version+1,updated_at=now() WHERE singleton=true',
        );
      }
      const nextRevision =
        'xp-' + (BigInt(state.version) + (changed ? 1n : 0n)).toString();
      const receipt: CompetitionReceipt = {
        outcome: changed ? 'applied' : 'unchanged',
        revision: nextRevision,
        scheduleId,
      };
      if (xp)
        await client.query(
          'INSERT INTO xp_import_history(id,actor_discord_id,actor_name,request_key,token_hash,expected_revision,competition_id,title,outcome,changes,resulting_revision,acknowledged_corrections) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            randomUUID(),
            actor,
            actorName,
            key,
            hash(token),
            revision,
            c.id,
            c.title,
            receipt.outcome,
            JSON.stringify(changes),
            nextRevision,
            acknowledgeCorrections,
          ],
        );
      // Audit only normalized metadata, lifecycle and action, never a live source response.
      await client.query(
        'INSERT INTO competition_import_history(id,actor_id,actor_name,request_key,request_hash,competition_id,title,kind,old_values,new_values,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          randomUUID(),
          actor,
          actorName,
          key,
          requestHash,
          c.id,
          c.title,
          c.kind,
          prior ? JSON.stringify(prior) : null,
          JSON.stringify({
            ...c,
            lifecycle,
            action,
            scheduleId,
            resultsImported: !!snapshot.results,
            changes,
          }),
          JSON.stringify(receipt),
        ],
      );
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

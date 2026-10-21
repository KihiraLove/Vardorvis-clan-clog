import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from './transaction.js';
import { ProjectionCache, projection } from './projection-cache.js';
import { PgCompetitionMetricStore } from './competition-metric-store.js';
import {
  competitionImportAction,
  competitionLifecycle,
  competitionScope,
  competitionDefinitions,
  competitionUsesPages,
  type WomCompetition,
} from '@clog/domain';
import { ApiError } from './types.js';
import { readState } from './scheduling-store.js';
import { competitionHash, mappedPages } from './competition-wom.js';
import {
  diffTotals,
  sumTotals,
  type XpEvent,
  type XpSnapshot,
  type XpApply,
} from './xp-types.js';
import type {
  CompetitionPreview,
  CompetitionReceipt,
  CompetitionSnapshot,
} from './competition-types.js';
/** Shared reconciliation owns both import protocols; adapters retain their wire contracts. */
export function requireXpCapacity(count: number, existing: boolean) {
  if (!existing && count >= 2000)
    throw new ApiError(
      409,
      'The XP tracker has reached its 2000-event capacity. Existing events can still be refreshed.',
    );
}
export function legacyCompetition(snapshot: XpSnapshot): CompetitionSnapshot {
  const metadata: Partial<WomCompetition> = snapshot.competition ?? {};
  const { standings, ...competition } = metadata;
  return {
    competition: {
      ...competition,
      id: snapshot.event.id,
      title: snapshot.event.title,
      sourceUrl: snapshot.event.sourceUrl,
      kind: 'SKILL',
      metrics: competition.metrics ?? snapshot.event.skills,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
    },
    skills: snapshot.event.skills,
    lifecycle: 'finished',
    results: { xp: snapshot, participants: standings ?? [] },
  };
}
function requireSnapshot(snapshot: CompetitionSnapshot) {
  let scope: ReturnType<typeof competitionScope>;
  try {
    scope = competitionScope(
      snapshot.competition.metrics,
      snapshot.competition.metricDefinitions,
    );
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
  if (
    scope.kind !== snapshot.competition.kind ||
    JSON.stringify(scope.skills) !== JSON.stringify(snapshot.skills)
  )
    throw new ApiError(
      422,
      'WOM metric scope does not match its canonical skills.',
    );
  const xp = snapshot.results?.xp;
  if (
    xp &&
    (scope.kind !== 'SKILL' ||
      xp.event.id !== snapshot.competition.id ||
      JSON.stringify(xp.event.skills) !== JSON.stringify(scope.skills))
  )
    throw new ApiError(
      422,
      'XP results do not match the competition identity and scope.',
    );
  if (snapshot.results && scope.kind === 'SKILL' && !xp)
    throw new ApiError(422, 'Finished SKILL imports require exact XP results.');
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function requireMetricRevision(
  client: pg.PoolClient,
  snapshot: CompetitionSnapshot,
  lock = false,
) {
  if (snapshot.metricRevision === undefined) return;
  const state = (
    await client.query<{ version: string }>(
      'SELECT version::text FROM competition_metric_state WHERE singleton' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  if (!state || snapshot.metricRevision !== 'metrics-' + state.version)
    throw new ApiError(409, 'Metric definitions changed. Preview again.');
}
type Stored = WomCompetition & {
  skills: string[];
  scheduleId: string | null;
  scheduleCreated: boolean;
  scheduleArchived: boolean;
  sourceHash: string | null;
  archivedAt: Date | null;
  resultsImportedAt: Date | null;
  activityResults:
    NonNullable<CompetitionSnapshot['results']>['participants'] | null;
  competitionResults:
    NonNullable<CompetitionSnapshot['results']>['participants'] | null;
};
async function stored(
  client: pg.PoolClient,
  id: number,
): Promise<Stored | undefined> {
  const row = (
    await client.query<Stored & { startsAt: Date; endsAt: Date }>(
      'SELECT competition_id::float8 AS id,kind,title,source_url AS "sourceUrl",metrics,metric_definitions AS "metricDefinitions",skills,starts_at AS "startsAt",ends_at AS "endsAt",schedule_id AS "scheduleId",schedule_created AS "scheduleCreated",(SELECT archived_at IS NOT NULL FROM collection_log_schedules WHERE id=wom_competitions.schedule_id) IS TRUE AS "scheduleArchived",source_hash AS "sourceHash",archived_at AS "archivedAt",results_imported_at AS "resultsImportedAt",activity_results AS "activityResults",competition_results AS "competitionResults" FROM wom_competitions WHERE competition_id=$1',
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
  for (const metric of competitionDefinitions(prior)) {
    if (
      metric.definition &&
      JSON.stringify(metric.definition) !==
        JSON.stringify(
          competitionDefinitions(snapshot.competition).find(
            (d) => d.metric === metric.metric,
          )?.definition,
        )
    )
      throw new ApiError(
        409,
        'Saved metric semantics changed. This competition retains its original definition.',
      );
  }
  if (prior.archivedAt)
    throw new ApiError(
      409,
      'Competition is archived. Restore it before importing again.',
    );
  if (prior.kind !== snapshot.competition.kind)
    throw new ApiError(
      422,
      'This WOM competition already has a different kind. Its identity cannot be duplicated.',
    );
  const old = prior.kind === 'SKILL' ? prior.skills : prior.metrics;
  const next =
    prior.kind === 'SKILL' ? snapshot.skills : snapshot.competition.metrics;
  if (old.some((metric) => !next.includes(metric)))
    throw new ApiError(
      422,
      'Removing saved WOM metrics requires manual reconciliation.',
    );
  if (prior.resultsImportedAt && snapshot.lifecycle !== 'finished')
    throw new ApiError(
      422,
      'A finalized competition cannot be replaced with live metadata.',
    );
}
async function xpEvents(client: pg.PoolClient): Promise<XpEvent[]> {
  const rows = (
    await client.query<XpEvent>(
      'SELECT competition_id::float8 AS id,title,source_url AS "sourceUrl",skills,gains FROM xp_events ORDER BY competition_id LIMIT 2001',
    )
  ).rows;
  if (rows.length > 2000) throw new ApiError(503, 'XP event limit exceeded.');
  return rows;
}
export class ImportReconciliation {
  readonly metricRegistry: PgCompetitionMetricStore;
  private readonly activityCache = new ProjectionCache<{
    competitions: WomCompetition[];
  }>();
  constructor(private readonly pool: pg.Pool) {
    this.metricRegistry = new PgCompetitionMetricStore(pool);
  }
  async clock(): Promise<number> {
    return (
      await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
  }
  private async loadActivities(client: pg.PoolClient) {
    const rows = (
      await client.query<WomCompetition & { startsAt: Date; endsAt: Date }>(
        'SELECT competition_id::float8 AS id,kind,title,source_url AS "sourceUrl",metrics,metric_definitions AS "metricDefinitions",starts_at AS "startsAt",ends_at AS "endsAt" FROM wom_competitions WHERE kind=\'ACTIVITY\' AND archived_at IS NULL ORDER BY ends_at DESC,competition_id DESC LIMIT 2001',
      )
    ).rows;
    if (rows.length > 2000)
      throw new ApiError(503, 'Competition listing exceeds supported limits.');
    return {
      competitions: rows.map((r) => ({
        ...r,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
      })),
    };
  }
  async activities() {
    const value = await projection(
      this.pool,
      this.activityCache,
      'activities',
      (client) => this.loadActivities(client),
    );
    return { serverNow: value.serverNow, ...value.data };
  }
  async activitySnapshot() {
    const value = await projection(
      this.pool,
      this.activityCache,
      'activities',
      (client) => this.loadActivities(client),
    );
    return {
      revision: value.key,
      serverNow: value.serverNow,
      body:
        '{"serverNow":' +
        JSON.stringify(value.serverNow) +
        ',' +
        value.json.slice(1),
    };
  }
  async preview(
    snapshot: CompetitionSnapshot,
    actor: string,
    pageIds?: string[],
    legacy = false,
  ): Promise<CompetitionPreview> {
    const token = randomBytes(32).toString('base64url');
    return transaction(this.pool, 'preview', async (client) => {
      await requireMetricRevision(client, snapshot);
      requireSnapshot(snapshot);
      const now = (
        await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now;
      const lifecycle = competitionLifecycle(
        snapshot.competition,
        now.getTime(),
      );
      if (legacy && lifecycle !== 'finished')
        throw new ApiError(
          422,
          'Use the competition schedule importer for future or running competitions. XP results are imported only after the end.',
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
      const metadataOnly = !competitionUsesPages(
        snapshot.competition.metrics,
        snapshot.competition.metricDefinitions,
      );
      if (metadataOnly && pageIds?.length)
        throw new ApiError(
          422,
          'These competition metrics do not open collection log pages. Import the metadata without page selections.',
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
          'SELECT count(*)::int AS count FROM (SELECT 1 FROM wom_competitions WHERE archived_at IS NULL LIMIT 2000) slots',
        )
      ).rows[0]!.count;
      requireXpCapacity(count, !!prior);
      const pages = metadataOnly
        ? []
        : (
            await client.query<{ id: string; name: string }>(
              'SELECT id,name FROM pages WHERE active ORDER BY category,sort_order,id',
            )
          ).rows;
      const pageBindings = metadataOnly
        ? []
        : (
            await client.query<{ source_key: string; local_id: string }>(
              "SELECT source_key,local_id FROM catalog_update_bindings WHERE kind='page'",
            )
          ).rows;
      const mapped = competitionDefinitions(snapshot.competition).flatMap(
        (d) =>
          d.definition?.pageIds ??
          mappedPages(d.metric).map(
            (key) =>
              pageBindings.find((b) => b.source_key === key)?.local_id ?? key,
          ),
      );
      const proposed = [...new Set(mapped)].filter((id) =>
        pages.some((p) => p.id === id),
      );
      const linked = schedules.schedules.find(
        (s) => s.id === prior?.scheduleId,
      );
      const addedPages = prior
        ? competitionDefinitions(snapshot.competition)
            .filter((d) => !prior.metrics.includes(d.metric))
            .flatMap(
              (d) =>
                d.definition?.pageIds ??
                mappedPages(d.metric).map(
                  (key) =>
                    pageBindings.find((b) => b.source_key === key)?.local_id ??
                    key,
                ),
            )
            .filter((id) => pages.some((p) => p.id === id))
        : [];
      const selected = metadataOnly
        ? []
        : linked
          ? [...new Set([...linked.pageIds, ...addedPages])].sort()
          : lifecycle === 'finished'
            ? []
            : (pageIds ?? proposed);
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
        !metadataOnly,
      );
      const events = snapshot.results?.xp ? await xpEvents(client) : [];
      if (snapshot.results?.xp)
        requireXpCapacity(
          events.length,
          events.some((e) => e.id === snapshot.competition.id),
        );
      const changes = snapshot.results?.xp
        ? diffTotals(
            sumTotals(events),
            events.find((e) => e.id === snapshot.competition.id) ?? null,
            snapshot.results.xp.event,
          )
        : [];
      const previousPlayers = snapshot.results?.xp
        ? (
            await client.query<{ participants: XpSnapshot['participants'] }>(
              "SELECT source_snapshot->'participants' AS participants FROM xp_events WHERE competition_id=$1",
              [snapshot.competition.id],
            )
          ).rows[0]?.participants
        : undefined;
      const expiresAt = new Date(now.getTime() + 600000).toISOString();
      if (legacy)
        await client.query(
          'INSERT INTO xp_previews(token_hash,actor_discord_id,expected_revision,snapshot,expires_at) VALUES($1,$2,$3,$4,$5)',
          [
            hash(token),
            actor,
            revision,
            JSON.stringify(snapshot.results!.xp),
            expiresAt,
          ],
        );
      else
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

      const warnings: string[] = [];
      if (
        previousPlayers &&
        snapshot.results?.xp &&
        (previousPlayers.length !== snapshot.results.xp.participants.length ||
          previousPlayers.some(
            (p) =>
              !snapshot.results!.xp!.participants.some(
                (next) => next.playerId === p.playerId,
              ),
          ))
      )
        warnings.push(
          'The competition participant roster changed. Review the reconciliation.',
        );
      if (prior?.scheduleArchived)
        warnings.push(
          'The linked staff schedule is archived and retained. This import will not restore or reopen it; manage its lifecycle separately.',
        );
      else if (metadataOnly && prior?.scheduleCreated)
        warnings.push(
          linked
            ? 'The previously linked staff schedule is preserved. This import will not edit or open pages; manage that schedule in Scheduling.'
            : 'The previously linked schedule was deleted. This import will not recreate it.',
        );
      if (mapped.some((id) => !pages.some((p) => p.id === id)))
        warnings.push(
          'Some mapped pages are unavailable. Review the active page selections before applying.',
        );
      if (action === 'preserve-deletion' && !prior?.scheduleArchived)
        warnings.push(
          'The linked schedule was deleted by staff. Importing again will preserve that deletion. Create a manual schedule to reopen pages.',
        );
      if (action === 'create-schedule' && !selected.length)
        warnings.push(
          'Choose at least one active page before applying. This metric has no automatic page mapping.',
        );
      if (!metadataOnly && !schedules.enabled && lifecycle !== 'finished')
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
          metadataOnly || lifecycle === 'finished'
            ? null
            : linked
              ? snapshot.competition.startsAt
              : lifecycle === 'running'
                ? now.toISOString()
                : snapshot.competition.startsAt,
        participants:
          snapshot.results?.xp?.participants ??
          snapshot.results?.participants ??
          [],
        changes,
        warnings,
        ...(snapshot.results
          ? { standings: snapshot.results.participants }
          : {}),
      };
    });
  }
  async apply(
    token: string,
    revision: string,
    scheduleRevision: string,
    key: string,
    actor: string,
    actorName: string,
    _role: 'admin' | 'moderator',
    acknowledgeCorrections: boolean,
    legacy = false,
  ): Promise<CompetitionReceipt> {
    const requestHash = competitionHash({
      token,
      revision,
      scheduleRevision,
      acknowledgeCorrections,
    });
    return transaction(this.pool, 'write', async (client) => {
      // Scheduling settings always precede XP state, competition and page locks.
      await client.query(
        'SELECT singleton FROM collection_scheduling WHERE singleton=true FOR UPDATE',
      );
      const state = (
        await client.query<{ version: string }>(
          'SELECT version::text FROM xp_state WHERE singleton=true FOR UPDATE',
        )
      ).rows[0]!;
      if (!state) throw new ApiError(503, 'XP state unavailable.');
      if (legacy) {
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

          return {
            outcome: replay.outcome,
            revision: replay.resulting_revision,
            scheduleId: null,
          };
        }
      }
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
      if (legacy && replay)
        throw new ApiError(
          409,
          'Import key already used for a different request.',
        );
      if (!legacy && replay) {
        if (replay.request_hash !== requestHash)
          throw new ApiError(
            409,
            'Import key already used for a different request.',
          );

        return replay.receipt;
      }
      // Old XP-only receipts also reserve their actor/key across protocols.
      if (
        !legacy &&
        (
          await client.query(
            'SELECT 1 FROM xp_import_history WHERE actor_discord_id=$1 AND request_key=$2',
            [actor, key],
          )
        ).rowCount
      )
        throw new ApiError(
          409,
          'Import key already used for a different request.',
        );
      let row = (
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
      if (legacy) {
        const saved = (
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
        row = saved && {
          actor_id: saved.actor_discord_id,
          expected_revision: saved.expected_revision,
          snapshot: legacyCompetition(saved.snapshot),
          expires_at: saved.expires_at,
          schedule_revision: '',
          page_ids: [],
        };
      }
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
        (!legacy &&
          (scheduleRevision !== row.schedule_revision ||
            scheduleRevision !== schedules.revision))
      )
        throw new ApiError(
          409,
          'Competitions or schedules changed. Preview again.',
        );
      const snapshot = row.snapshot,
        c = snapshot.competition;
      await requireMetricRevision(client, snapshot, true);
      requireSnapshot(snapshot);
      if (
        !competitionUsesPages(c.metrics, c.metricDefinitions) &&
        row.page_ids.length
      )
        throw new ApiError(
          409,
          'Competition page-opening behavior changed. Preview again to import without opening pages.',
        );
      const lifecycle = competitionLifecycle(c, now.getTime());
      if ((lifecycle === 'finished') !== !!snapshot.results)
        throw new ApiError(
          409,
          'Competition changed time state. Preview again to fetch final results.',
        );
      const prior = await stored(client, c.id);
      requireScope(prior, { ...snapshot, lifecycle });
      if (
        !prior &&
        (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM (SELECT 1 FROM wom_competitions WHERE archived_at IS NULL LIMIT 2000) slots',
          )
        ).rows[0]!.count >= 2000
      )
        requireXpCapacity(2000, false);
      let scheduleId = prior?.scheduleId ?? null;
      const action = competitionImportAction(
        c.kind,
        lifecycle,
        prior?.scheduleCreated,
        schedules.schedules.some((s) => s.id === scheduleId),
        competitionUsesPages(c.metrics, c.metricDefinitions),
      );
      const createSchedule = action === 'create-schedule';
      const linked = schedules.schedules.find((s) => s.id === scheduleId);
      const updateSchedule =
        !!linked && competitionUsesPages(c.metrics, c.metricDefinitions);
      const addedPages = linked
        ? row.page_ids.filter((id) => !linked.pageIds.includes(id))
        : [];
      const scheduleChanged =
        createSchedule ||
        (updateSchedule &&
          (linked.startsAt !== c.startsAt ||
            linked.endsAt !== c.endsAt ||
            addedPages.length > 0));
      if (updateSchedule && addedPages.length) {
        const pages = await client.query(
          'SELECT id FROM pages WHERE id=ANY($1::text[]) AND active ORDER BY id FOR SHARE',
          [addedPages],
        );
        if (pages.rowCount !== addedPages.length)
          throw new ApiError(409, 'Mapped pages changed. Preview again.');
      }
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
      }
      if (updateSchedule && scheduleChanged) {
        await client.query(
          'UPDATE collection_log_schedules SET starts_at=$2,ends_at=$3 WHERE id=$1 AND archived_at IS NULL',
          [scheduleId, c.startsAt, c.endsAt],
        );
        if (addedPages.length)
          await client.query(
            'INSERT INTO collection_log_schedule_pages(schedule_id,page_id) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',
            [scheduleId, addedPages],
          );
      }
      if (scheduleChanged) {
        const version = (
          await client.query<{ version: number }>(
            'UPDATE collection_scheduling SET version=version+1 WHERE singleton=true RETURNING version',
          )
        ).rows[0]!.version;
        const after = await readState(client);
        await client.query(
          'INSERT INTO collection_schedule_audit(actor_id,actor_name,action,version,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6)',
          [
            actor,
            actorName,
            createSchedule ? 'create' : 'edit',
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
        !prior || prior.sourceHash !== sourceHash || scheduleChanged;
      const xp = snapshot.results?.xp;
      const events = xp ? await xpEvents(client) : [];
      if (xp)
        requireXpCapacity(
          events.length,
          events.some((e) => e.id === c.id),
        );
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
          'INSERT INTO wom_competitions(competition_id,kind,title,source_url,metrics,skills,starts_at,ends_at,schedule_id,schedule_created,results_imported_at,activity_results,source_hash,metric_definitions,competition_results) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(competition_id) DO UPDATE SET title=EXCLUDED.title,source_url=EXCLUDED.source_url,metrics=EXCLUDED.metrics,skills=EXCLUDED.skills,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,schedule_id=EXCLUDED.schedule_id,schedule_created=EXCLUDED.schedule_created,results_imported_at=EXCLUDED.results_imported_at,activity_results=EXCLUDED.activity_results,source_hash=EXCLUDED.source_hash,metric_definitions=EXCLUDED.metric_definitions,competition_results=EXCLUDED.competition_results',
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
            JSON.stringify(competitionDefinitions(c)),
            JSON.stringify(snapshot.results?.participants ?? []),
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
      // Retain normalized before/after evidence atomically, never a raw source response.
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
            resultsEvidenceVersion: 1,
            competitionResults: snapshot.results?.participants ?? null,
            activityResults:
              c.kind === 'ACTIVITY'
                ? (snapshot.results?.participants ?? null)
                : null,
          }),
          JSON.stringify(receipt),
        ],
      );

      return receipt;
    });
  }
}

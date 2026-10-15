/** Transactional snapshots; retries survive process restarts and preview expiry. */
import type pg from 'pg';
import {
  ImportReconciliation,
  legacyCompetition,
} from './import-reconciliation.js';
export { requireXpCapacity } from './import-reconciliation.js';
import { ProjectionCache, projection } from './projection-cache.js';
import { ApiError } from './types.js';
import {
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

const maxEvents = 2000;
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
  private readonly trackerCache = new ProjectionCache<
    Awaited<ReturnType<XpStore['tracker']>>
  >();
  private readonly imports: ImportReconciliation;
  constructor(private readonly pool: pg.Pool) {
    this.imports = new ImportReconciliation(pool);
  }
  private async state(client: pg.PoolClient) {
    const row = (
      await client.query<{ version: string }>(
        'SELECT version::text AS version FROM xp_state WHERE singleton=true',
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
  private async buildTracker(client: pg.PoolClient) {
    const revision = await this.state(client);
    const rows = await this.events(client);
    const totals = sumTotals(rows.map(event));
    const byIdentity = new Map(rows.map((row) => [row.competition_id, row]));
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
      const source = byIdentity.get(item.competition_id);
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
      const r = byIdentity.get(String(m.id));
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
    return { revision, totals, events, podium };
  }
  async tracker() {
    return (
      await projection(this.pool, this.trackerCache, 'xp', (client) =>
        this.buildTracker(client),
      )
    ).data;
  }
  async trackerSnapshot() {
    const value = await projection(
      this.pool,
      this.trackerCache,
      'xp',
      (client) => this.buildTracker(client),
    );
    return { revision: value.key, body: value.json };
  }
  async preview(snapshot: XpSnapshot, actor: string): Promise<XpPreview> {
    const value = await this.imports.preview(
      legacyCompetition(snapshot),
      actor,
      undefined,
      true,
    );
    return {
      previewToken: value.previewToken,
      expectedRevision: value.expectedRevision,
      expiresAt: value.expiresAt,
      competition: {
        id: value.competition.id,
        title: value.competition.title,
        sourceUrl: value.competition.sourceUrl,
        skills: snapshot.event.skills,
        startsAt: value.competition.startsAt,
        endsAt: value.competition.endsAt,
        importedAt: new Date().toISOString(),
      },
      participants: snapshot.participants,
      changes: value.changes,
      warnings: value.warnings,
    };
  }
  async apply(
    token: string,
    revision: string,
    key: string,
    actor: string,
    actorName: string,
    acknowledgeCorrections: boolean,
  ): Promise<XpApply> {
    const { outcome, revision: next } = await this.imports.apply(
      token,
      revision,
      '',
      key,
      actor,
      actorName,
      'admin',
      acknowledgeCorrections,
      true,
    );
    return { outcome, revision: next };
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

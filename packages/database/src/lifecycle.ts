/** Bounded historical reads and explicit owner-operated, reversible archival. */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pathToFileURL } from 'node:url';

export type LifecycleResource = 'schedules' | 'competitions';
export type LifecycleView = 'current' | 'archived';
export class LifecycleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const targets = {
  schedules: {
    table: 'collection_log_schedules',
    key: 'id',
    cast: 'uuid',
    capacity: 500,
  },
  competitions: {
    table: 'wom_competitions',
    key: 'competition_id',
    cast: 'bigint',
    capacity: 2000,
  },
} as const;
function target(resource: LifecycleResource) {
  if (!Object.hasOwn(targets, resource))
    throw new LifecycleError(400, 'Choose schedules or competitions.');
  return targets[resource];
}
function identifier(resource: LifecycleResource, value: string) {
  if (
    typeof value !== 'string' ||
    (resource === 'schedules'
      ? !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          value,
        )
      : !/^[1-9][0-9]{0,18}$/u.test(value) ||
        BigInt(value) > 9223372036854775807n)
  )
    throw new LifecycleError(400, 'Invalid lifecycle record ID.');
}
const encode = (
  revision: string,
  resource: LifecycleResource,
  view: LifecycleView,
  limit: number,
  key: string | null,
) =>
  Buffer.from(
    JSON.stringify({ revision, resource, view, limit, key }),
  ).toString('base64url');
function decode(
  cursor: string | undefined,
  revision: string,
  resource: LifecycleResource,
  view: LifecycleView,
  limit: number,
) {
  if (cursor === undefined) return null;
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor))
      throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !value ||
      value.revision !== revision ||
      value.resource !== resource ||
      value.view !== view ||
      value.limit !== limit
    )
      throw new Error();
    if (value.key === null) return null;
    identifier(resource, value.key);
    return value.key as string;
  } catch {
    throw new LifecycleError(
      409,
      'Lifecycle records changed or cursor expired. Reload the first page.',
    );
  }
}
async function snapshot(
  client: pg.PoolClient,
  resource: LifecycleResource,
  id: string,
) {
  const t = target(resource);
  const record = (
    await client.query<{ record: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS record FROM ${t.table} t WHERE ${t.key}=$1`,
      [id],
    )
  ).rows[0]?.record;
  if (!record) throw new LifecycleError(404, 'Lifecycle record not found.');
  const pages = async (scheduleId: string) => {
    const rows = (
      await client.query<{ page_id: string }>(
        'SELECT page_id FROM collection_log_schedule_pages WHERE schedule_id=$1 ORDER BY page_id LIMIT 201',
        [scheduleId],
      )
    ).rows;
    if (rows.length > 200)
      throw new LifecycleError(
        503,
        'Schedule page membership exceeds supported limits.',
      );
    return rows.map((row) => row.page_id);
  };
  if (resource === 'schedules') return { record, pageIds: await pages(id) };
  const xp =
    (
      await client.query(
        'SELECT to_jsonb(e) AS record FROM xp_events e WHERE competition_id=$1',
        [id],
      )
    ).rows[0]?.record ?? null;
  const linkedId = record.schedule_id as string | null;
  const linkedSchedule = linkedId
    ? {
        record:
          (
            await client.query(
              'SELECT to_jsonb(s) AS record FROM collection_log_schedules s WHERE id=$1',
              [linkedId],
            )
          ).rows[0]?.record ?? null,
        pageIds: await pages(linkedId),
      }
    : null;
  return { record, xp, linkedSchedule };
}
export class PgLifecycleStore {
  constructor(private readonly pool: pg.Pool) {}
  private async read<T>(operation: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async list(
    resource: LifecycleResource,
    view: LifecycleView = 'archived',
    cursor?: string,
    limit = 20,
  ) {
    const t = target(resource);
    if (
      !['current', 'archived'].includes(view) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new LifecycleError(
        400,
        'Choose current/archived and a page size of 1–20.',
      );
    return this.read(async (client) => {
      const version = (
        await client.query(
          'SELECT version::text FROM lifecycle_state WHERE singleton',
        )
      ).rows[0]?.version;
      if (!version)
        throw new LifecycleError(503, 'Lifecycle state unavailable.');
      const revision = 'lifecycle-' + version,
        key = decode(cursor, revision, resource, view, limit);
      const rows = (
        await client.query<{
          id: string;
          title: string;
          startsAt: Date;
          endsAt: Date;
          archivedAt: Date | null;
        }>(
          `SELECT ${t.key}::text AS id,title,starts_at AS "startsAt",ends_at AS "endsAt",archived_at AS "archivedAt"
         FROM ${t.table} WHERE archived_at IS ${view === 'current' ? '' : 'NOT '}NULL
         ${key ? `AND ${t.key} > $2::${t.cast}` : ''} ORDER BY ${t.table}.${t.key} LIMIT $1`,
          key ? [limit + 1, key] : [limit + 1],
        )
      ).rows;
      const records = rows.slice(0, limit),
        last = records.at(-1);
      return {
        revision,
        pageCursor: encode(revision, resource, view, limit, key),
        nextCursor:
          rows.length > limit && last
            ? encode(revision, resource, view, limit, last.id)
            : null,
        records: records.map((row) => ({
          ...row,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          archivedAt: row.archivedAt?.toISOString() ?? null,
        })),
      };
    });
  }
  async detail(resource: LifecycleResource, id: string) {
    target(resource);
    identifier(resource, id);
    if (resource === 'schedules') id = id.toLowerCase();
    return this.read((client) => snapshot(client, resource, id));
  }
  async change(
    resource: LifecycleResource,
    id: string,
    action: 'archive' | 'restore',
    actor: string,
    reason: string,
    apply = false,
  ) {
    const t = target(resource);
    identifier(resource, id);
    if (resource === 'schedules') id = id.toLowerCase();
    if (
      !['archive', 'restore'].includes(action) ||
      typeof actor !== 'string' ||
      !actor.trim() ||
      actor.trim().length > 80 ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 1000
    )
      throw new LifecycleError(
        400,
        'An archive/restore action, operator name and reason are required.',
      );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='3s'");
      // Same global order as competition applies; legacy XP writes acquire XP only.
      await client.query(
        'SELECT singleton FROM collection_scheduling WHERE singleton FOR UPDATE',
      );
      await client.query(
        'SELECT singleton FROM xp_state WHERE singleton FOR UPDATE',
      );
      const row = (
        await client.query<{ archived_at: Date | null; ended: boolean }>(
          `SELECT archived_at,ends_at<=clock_timestamp() AS ended FROM ${t.table} WHERE ${t.key}=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!row) throw new LifecycleError(404, 'Lifecycle record not found.');
      const before = await snapshot(client, resource, id);
      if ((action === 'archive') === !!row.archived_at) {
        await client.query('ROLLBACK');
        return {
          mode: apply ? 'apply' : 'dry-run',
          outcome: 'unchanged',
          resource,
          id,
          before,
        };
      }
      if (action === 'archive' && !row.ended)
        throw new LifecycleError(409, 'Only ended records can be archived.');
      if (action === 'restore') {
        const count = (
          await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM (SELECT 1 FROM ${t.table} WHERE archived_at IS NULL LIMIT ${t.capacity}) slots`,
          )
        ).rows[0]!.count;
        if (count >= t.capacity)
          throw new LifecycleError(
            409,
            'Current record capacity reached; archive an ended record before restoring.',
          );
      }
      if (!apply) {
        await client.query('ROLLBACK');
        return { mode: 'dry-run', outcome: 'eligible', resource, id, before };
      }
      await client.query(
        `UPDATE ${t.table} SET archived_at=${action === 'archive' ? 'clock_timestamp()' : 'NULL'} WHERE ${t.key}=$1`,
        [id],
      );
      const after = await snapshot(client, resource, id);
      await client.query(
        'INSERT INTO lifecycle_archive_audit(id,resource,resource_id,action,actor_name,reason,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          resource,
          id,
          action,
          actor.trim(),
          reason.trim(),
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      // Invalidate any preview that predates this explicit operational change.
      await client.query(
        'UPDATE collection_scheduling SET version=version+1 WHERE singleton',
      );
      await client.query(
        'UPDATE xp_state SET version=version+1,updated_at=now() WHERE singleton',
      );
      await client.query('COMMIT');
      return { mode: 'apply', outcome: 'applied', resource, id, before, after };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2),
    values = new Map<string, string>();
  let apply = false;
  for (const arg of args) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else {
      const match =
        /^--(resource|action|id|view|cursor|limit|actor|reason)=(.+)$/u.exec(
          arg,
        );
      if (!match || values.has(match[1]!))
        throw new Error(
          'Unknown or duplicate option. See docs/maintenance.md.',
        );
      values.set(match[1]!, match[2]!);
    }
  }
  const resource = values.get('resource') as LifecycleResource,
    action = values.get('action') ?? 'list';
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    max: 1,
  });
  try {
    const store = new PgLifecycleStore(pool);
    const result =
      action === 'list'
        ? await store.list(
            resource,
            (values.get('view') ?? 'archived') as LifecycleView,
            values.get('cursor'),
            Number(values.get('limit') ?? 20),
          )
        : action === 'detail'
          ? await store.detail(resource, values.get('id') ?? '')
          : await store.change(
              resource,
              values.get('id') ?? '',
              action as 'archive' | 'restore',
              values.get('actor') ?? '',
              values.get('reason') ?? '',
              apply,
            );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

import { databaseUrl as readDatabaseUrl } from './secrets.js';
/** B08/R03: one-shot, opt-in cleanup. Never delete durable import receipts. */
import pg from 'pg';

const advisoryKey = 74261079;
const targets = ['xp_previews', 'competition_previews'] as const;
type Target = (typeof targets)[number];

export interface PreviewMaintenanceOptions {
  dryRun: boolean;
  batchSize: number;
  maxBatches: number;
  graceMinutes: number;
}

export function validatePreviewMaintenanceOptions(
  value: PreviewMaintenanceOptions,
): PreviewMaintenanceOptions {
  if (
    !Number.isInteger(value.batchSize) ||
    value.batchSize < 1 ||
    value.batchSize > 500 ||
    !Number.isInteger(value.maxBatches) ||
    value.maxBatches < 1 ||
    value.maxBatches > 20 ||
    !Number.isInteger(value.graceMinutes) ||
    value.graceMinutes < 60 ||
    value.graceMinutes > 10080
  )
    throw new Error(
      'Use --batch-size 1..500, --max-batches 1..20 and --grace-minutes 60..10080.',
    );
  return value;
}

interface Counts {
  total: number;
  eligible: number;
  oldest: Date | null;
}
async function counts(client: pg.Client, table: Target, cutoff: Date) {
  // Names are hardcoded, never supplied by the user. The expiry index is used
  // for the eligible count; do not load any of the large JSON snapshots.
  // A single pg.Client does not support concurrent query() execution.
  const total = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM ' + table,
  );
  const eligible = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM ' + table + ' WHERE expires_at <= $1',
    [cutoff],
  );
  const oldest = await client.query<{ expires_at: Date }>(
    'SELECT expires_at FROM ' +
      table +
      ' ORDER BY expires_at,token_hash LIMIT 1',
  );
  return {
    total: total.rows[0]!.count,
    eligible: eligible.rows[0]!.count,
    oldest: oldest.rows[0]?.expires_at ?? null,
  } satisfies Counts;
}

async function deleteBatch(
  client: pg.Client,
  table: Target,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  // Short transactions and SKIP LOCKED avoid blocking an apply that holds
  // FOR KEY SHARE on a preview. Its receipt and audit are in other tables.
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query<{ count: number }>(
      'WITH batch AS (' +
        ' SELECT token_hash FROM ' +
        table +
        ' WHERE expires_at <= $1' +
        ' ORDER BY expires_at,token_hash LIMIT $2 FOR UPDATE SKIP LOCKED' +
        '), removed AS (' +
        ' DELETE FROM ' +
        table +
        ' WHERE token_hash IN (SELECT token_hash FROM batch)' +
        ' RETURNING token_hash' +
        ') SELECT count(*)::int AS count FROM removed',
      [cutoff, batchSize],
    );
    await client.query('COMMIT');
    return result.rows[0]!.count;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runPreviewMaintenance(
  client: pg.Client,
  options: PreviewMaintenanceOptions,
) {
  const { dryRun, batchSize, maxBatches, graceMinutes } =
    validatePreviewMaintenanceOptions(options);
  const obtained = (
    await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [advisoryKey],
    )
  ).rows[0]!.acquired;
  if (!obtained)
    throw new Error(
      'Another import preview maintenance command is active. No rows were changed.',
    );
  try {
    await client.query("SET statement_timeout = '10s'");
    const now = (
      await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    const cutoff = new Date(now.getTime() - graceMinutes * 60000);
    const report: {
      mode: 'dry-run' | 'apply';
      cutoff: string;
      graceMinutes: number;
      maximumDeletesPerTable: number;
      tables: Record<
        Target,
        {
          before: Counts;
          deleted: number;
          after: Counts;
          batches: number;
        }
      >;
    } = {
      mode: dryRun ? 'dry-run' : 'apply',
      cutoff: cutoff.toISOString(),
      graceMinutes,
      maximumDeletesPerTable: batchSize * maxBatches,
      tables: {} as Record<
        Target,
        { before: Counts; deleted: number; after: Counts; batches: number }
      >,
    };
    for (const table of targets) {
      const before = await counts(client, table, cutoff);
      let deleted = 0;
      let batches = 0;
      if (!dryRun)
        for (let index = 0; index < maxBatches; index++) {
          const removed = await deleteBatch(client, table, cutoff, batchSize);
          if (removed === 0) break;
          deleted += removed;
          batches++;
          if (removed < batchSize) break;
        }
      report.tables[table] = {
        before,
        deleted,
        after: dryRun ? before : await counts(client, table, cutoff),
        batches,
      };
    }
    return report;
  } finally {
    // Advisory session lock ends on disconnect even after process termination.
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryKey]);
  }
}

function parseOptions(args: string[]): PreviewMaintenanceOptions {
  const options: PreviewMaintenanceOptions = {
    dryRun: true,
    batchSize: 200,
    maxBatches: 5,
    graceMinutes: 60,
  };
  for (const arg of args) {
    if (arg === '--apply') options.dryRun = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--batch-size='))
      options.batchSize = Number(arg.slice('--batch-size='.length));
    else if (arg.startsWith('--max-batches='))
      options.maxBatches = Number(arg.slice('--max-batches='.length));
    else if (arg.startsWith('--grace-minutes='))
      options.graceMinutes = Number(arg.slice('--grace-minutes='.length));
    else
      throw new Error(
        'Unknown maintenance option. Use --apply, --dry-run, --batch-size=N, --max-batches=N, --grace-minutes=N.',
      );
  }
  return validatePreviewMaintenanceOptions(options);
}

if (
  process.argv[1] &&
  import.meta.url === new URL('file://' + process.argv[1]).href
) {
  // The restricted app role deliberately has no DELETE on these tables.
  // Invoke as a one-shot migrate container, not the running app.
  const url = readDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  try {
    const options = parseOptions(process.argv.slice(2));
    await client.connect();
    const report = await runPreviewMaintenance(client, options);
    console.log(JSON.stringify(report));
  } finally {
    await client.end().catch(() => undefined);
  }
}

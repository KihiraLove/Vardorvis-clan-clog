import { databaseUrl as readDatabaseUrl } from './secrets.js';
/** B08/R03: bounded, opt-in collection with durable retirement before unlink. */
import { lstat, opendir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Stats } from 'node:fs';
import pg from 'pg';

type Kind = 'icons' | 'branding' | 'proofs';
const kinds: Kind[] = ['icons', 'branding', 'proofs'];
const workerLock = 74261081;
const writeLock = 74261080;
const filename =
  /^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(png|webp)(\.tmp)?$/u;
export interface AssetMaintenanceOptions {
  dryRun: boolean;
  graceHours: number;
  maxFiles: number;
  maxEntries: number;
  iconsOffset: number;
  brandingOffset: number;
  proofsOffset: number;
}
export const assetMaintenanceDefaults: AssetMaintenanceOptions = {
  dryRun: true,
  graceHours: 24,
  maxFiles: 100,
  maxEntries: 1000,
  iconsOffset: 0,
  brandingOffset: 0,
  proofsOffset: 0,
};
export function validateAssetMaintenanceOptions(
  options: AssetMaintenanceOptions,
) {
  if (typeof options.dryRun !== 'boolean')
    throw new Error('Specify dryRun explicitly.');
  for (const [key, min, max] of [
    ['graceHours', 24, 8760],
    ['maxFiles', 1, 500],
    ['maxEntries', 1, 10000],
    ['iconsOffset', 0, 1000000],
    ['brandingOffset', 0, 1000000],
    ['proofsOffset', 0, 1000000],
  ] as const) {
    if (
      !Number.isInteger(options[key]) ||
      options[key] < min ||
      options[key] > max
    )
      throw new Error(`Invalid ${key}: use ${min}..${max}.`);
  }
  return options;
}
const retained = `SELECT
  EXISTS(SELECT 1 FROM submission_images WHERE id=$1::text::uuid)
  OR EXISTS(SELECT 1 FROM clan_logo_assets WHERE id=$1::text::uuid OR favicon_id=$1::text::uuid)
  OR EXISTS(SELECT 1 FROM catalog_assets WHERE id=$1::text::uuid AND
    (item_id IS NOT NULL OR expires_at>$2 OR created_at>$2))
  OR EXISTS(SELECT 1 FROM items WHERE icon_asset_id=$1::text::uuid OR position($1 in icon_path)>0)
  OR EXISTS(SELECT 1 FROM catalog_audit WHERE position($1 in before_value::text)>0 OR position($1 in after_value::text)>0)
  OR EXISTS(SELECT 1 FROM catalog_requests WHERE position($1 in result::text)>0)
  OR EXISTS(SELECT 1 FROM catalog_page_requests WHERE position($1 in result::text)>0)
  OR EXISTS(SELECT 1 FROM audit_events WHERE position($1 in old_values::text)>0 OR position($1 in new_values::text)>0)
  OR EXISTS(SELECT 1 FROM manual_submission_requests WHERE position($1 in response::text)>0)
  OR EXISTS(SELECT 1 FROM runelite_submission_requests WHERE position($1 in response::text)>0)
  OR EXISTS(SELECT 1 FROM submissions WHERE proof_image_id=$1::text::uuid OR position($1 in proof_url)>0 OR position($1 in intake_receipt::text)>0)
  AS retained`;

/** Hooks only expose crash/race boundaries to the integration tests. */
interface Hooks {
  afterRetirement?: (kind: Kind, name: string) => Promise<void>;
}
export async function runAssetMaintenance(
  client: pg.Client,
  directories: Record<Kind, string>,
  input: AssetMaintenanceOptions,
  hooks: Hooks = {},
) {
  const options = validateAssetMaintenanceOptions(input);
  if (
    (
      await client.query<{ isolation: string }>(
        "SELECT current_setting('transaction_isolation') AS isolation",
      )
    ).rows[0]!.isolation !== 'read committed'
  )
    throw new Error(
      'Asset maintenance requires an idle READ COMMITTED connection.',
    );
  const roots = {} as Record<Kind, string>;
  for (const kind of kinds) {
    const value = directories[kind];
    if (!isAbsolute(value) || resolve(value) === parse(value).root)
      throw new Error('Supply dedicated absolute icon/proof directories.');
    const stat = await lstat(value);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Storage root must be a real directory.');
    roots[kind] = await realpath(value);
  }
  if (new Set(Object.values(roots)).size !== kinds.length)
    throw new Error('Storage directories must be distinct.');
  if (
    !(
      await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1,hashtext(current_schema())) AS acquired',
        [workerLock],
      )
    ).rows[0]!.acquired
  )
    throw new Error('Another asset maintenance command is active.');
  const started = Date.now();
  try {
    await client.query("SET statement_timeout='10s'");
    // Missing/disabled database barriers must fail before any filesystem mutation.
    const guards = await client.query<{
      count: number;
    }>(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgrelid IN ('catalog_assets'::regclass,'items'::regclass,'clan_logo_assets'::regclass,'submission_images'::regclass)
      AND tgname IN ('catalog_assets_retirement','catalog_items_retirement','logo_assets_retirement','proof_assets_retirement')
      AND tgenabled IN ('O','A') AND tgfoid='reject_retired_asset()'::regprocedure`);
    if (guards.rows[0]!.count !== 4)
      throw new Error(
        'Apply migration 016 and enable its asset write barriers first.',
      );
    const now = (
      await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    const cutoff = new Date(now.getTime() - options.graceHours * 3600000);
    const report = {
      mode: options.dryRun ? 'dry-run' : 'apply',
      cutoff: cutoff.toISOString(),
      maxFiles: options.maxFiles,
      maxEntriesPerDirectory: options.maxEntries,
      checked: 0,
      eligible: 0,
      retired: 0,
      removed: 0,
      bytesReclaimed: 0,
      referenced: 0,
      fresh: 0,
      unsafe: 0,
      unknown: 0,
      missing: 0,
      busy: 0,
      errors: 0,
      timeLimitReached: false,
      stores: {
        icons: { scanned: 0, nextOffset: 0 },
        branding: { scanned: 0, nextOffset: 0 },
        proofs: { scanned: 0, nextOffset: 0 },
      },
    };
    const seen = new Set<string>();
    const limited = () => {
      report.timeLimitReached = Date.now() - started >= 30000;
      return report.checked >= options.maxFiles || report.timeLimitReached;
    };
    async function inspect(kind: Kind, name: string, pending = false) {
      if (seen.has(kind + ':' + name) || limited()) return;
      seen.add(kind + ':' + name);
      const match = filename.exec(name);
      if (!match || (kind === 'proofs' && match[2] !== 'png')) {
        report.unknown++;
        return;
      }
      const location = join(roots[kind], name);
      let before: Stats;
      try {
        before = await lstat(location);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        report.missing++;
        if (pending && !options.dryRun)
          await client.query(
            'UPDATE asset_retirements SET removed_at=clock_timestamp() WHERE storage_kind=$1 AND file_name=$2',
            [kind, name],
          );
        return;
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        report.unsafe++;
        return;
      }
      if (before.mtimeMs > cutoff.getTime()) {
        report.fresh++;
        return;
      }
      report.checked++;
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='2s'");
        if (
          !(
            await client.query<{ acquired: boolean }>(
              'SELECT pg_try_advisory_xact_lock($1,hashtext(current_schema())) AS acquired',
              [writeLock],
            )
          ).rows[0]!.acquired
        ) {
          report.busy++;
          await client.query('ROLLBACK');
          return;
        }
        if (
          (
            await client.query<{ retained: boolean }>(retained, [
              match[1],
              cutoff,
            ])
          ).rows[0]!.retained
        ) {
          report.referenced++;
          // An unexpected reference after retirement is a repair condition, never permission to unlink.
          if (pending) report.errors++;
          await client.query('ROLLBACK');
          return;
        }
        report.eligible++;
        if (options.dryRun) {
          await client.query('ROLLBACK');
          return;
        }
        await client.query(
          'INSERT INTO asset_retirements(storage_kind,file_name) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [kind, name],
        );
        await client.query('COMMIT');
        report.retired++;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      await hooks.afterRetirement?.(kind, name);
      try {
        const current = await lstat(location);
        if (
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        ) {
          report.unsafe++;
          report.errors++;
          return;
        }
        await unlink(location);
        report.removed++;
        report.bytesReclaimed += before.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          report.missing++;
        else {
          report.errors++;
          return;
        }
      }
      await client.query(
        'UPDATE asset_retirements SET removed_at=clock_timestamp() WHERE storage_kind=$1 AND file_name=$2',
        [kind, name],
      );
    }
    // A committed retirement survives interruption before/after unlink. Replay it first.
    const pending = await client.query<{
      storage_kind: Kind;
      file_name: string;
    }>(
      'SELECT storage_kind,file_name FROM asset_retirements WHERE removed_at IS NULL ORDER BY retired_at,storage_kind,file_name LIMIT $1',
      [options.maxFiles],
    );
    for (const row of pending.rows)
      await inspect(row.storage_kind, row.file_name, true);
    for (const kind of kinds) {
      if (limited()) break;
      const offset = options[`${kind}Offset`];
      const directory = await opendir(roots[kind]);
      let position = 0;
      try {
        while (!limited()) {
          // Offset traversal has a hard cap (1,000,000) and the shared time limit.
          const entry = await directory.read();
          if (!entry) {
            report.stores[kind].nextOffset = 0;
            break;
          }
          position++;
          if (position <= offset) continue;
          report.stores[kind].scanned++;
          report.stores[kind].nextOffset = position;
          await inspect(kind, entry.name);
          if (report.stores[kind].scanned >= options.maxEntries) break;
        }
      } finally {
        await directory.close();
      }
    }
    return report;
  } finally {
    await client.query(
      'SELECT pg_advisory_unlock($1,hashtext(current_schema()))',
      [workerLock],
    );
  }
}

export function parseAssetMaintenanceOptions(args: string[]) {
  const options = { ...assetMaintenanceDefaults };
  const names = {
    'grace-hours': 'graceHours',
    'max-files': 'maxFiles',
    'max-entries': 'maxEntries',
    'icons-offset': 'iconsOffset',
    'branding-offset': 'brandingOffset',
    'proofs-offset': 'proofsOffset',
  } as const;
  for (const arg of args) {
    if (arg === '--apply' || arg === '--dry-run')
      options.dryRun = arg === '--dry-run';
    else {
      const match = /^--([a-z-]+)=(\d+)$/u.exec(arg);
      const key = match?.[1] as keyof typeof names;
      if (!match || !Object.hasOwn(names, key))
        throw new Error('Unknown asset maintenance option.');
      options[names[key]] = Number(match[2]);
    }
  }
  return validateAssetMaintenanceOptions(options);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = parseAssetMaintenanceOptions(process.argv.slice(2));
  const client = new pg.Client({
    connectionString: readDatabaseUrl(),
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  try {
    if (!readDatabaseUrl()) throw new Error('DATABASE_URL is required.');
    await client.connect();
    const report = await runAssetMaintenance(
      client,
      {
        icons: process.env.ICON_STORAGE_PATH ?? '',
        branding: process.env.ICON_STORAGE_PATH
          ? join(process.env.ICON_STORAGE_PATH, 'branding')
          : '',
        proofs: process.env.PROOF_STORAGE_PATH ?? '',
      },
      options,
    );
    console.log(JSON.stringify(report));
    if (report.errors) process.exitCode = 1;
  } catch {
    console.error(
      'Asset maintenance did not complete. Check database/mount configuration and retry; committed retirements remain safe to resume.',
    );
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

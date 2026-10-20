import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';
import {
  assetMaintenanceDefaults,
  parseAssetMaintenanceOptions,
  runAssetMaintenance,
} from './asset-maintenance.js';

test('asset maintenance defaults to inspection and rejects unsafe or unbounded options', () => {
  assert.deepEqual(parseAssetMaintenanceOptions([]), assetMaintenanceDefaults);
  for (const arg of [
    '--grace-hours=23',
    '--max-files=0',
    '--max-files=501',
    '--max-entries=10001',
    '--icons-offset=1000001',
    '--proofs-offset=-1',
    '--apply=true',
    '--unknown=1',
  ])
    assert.throws(() => parseAssetMaintenanceOptions([arg]));
  assert.equal(parseAssetMaintenanceOptions(['--apply']).dryRun, false);
});

test(
  'asset retirement preserves evidence, bounds work and safely resumes interrupted/racing uploads',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'asset_gc_' + randomUUID().replaceAll('-', '');
    const root = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await root.connect();
    const directory = await mkdtemp(join(tmpdir(), 'clog-assets-'));
    const directories = {
      icons: join(directory, 'icons'),
      branding: join(directory, 'icons', 'branding'),
      proofs: join(directory, 'proofs'),
    };
    await Promise.all(
      Object.values(directories).map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', '-c search_path=' + schema);
    const worker = new pg.Client({ connectionString: url.href });
    const writer = new pg.Client({ connectionString: url.href });
    const options = {
      ...assetMaintenanceDefaults,
      dryRun: false,
      maxFiles: 100,
      maxEntries: 1000,
    };
    const old = new Date(Date.now() - 72 * 3600000);
    async function file(
      kind: 'icons' | 'branding' | 'proofs',
      suffix = '.webp',
      id = randomUUID(),
      aged = true,
    ) {
      const name = id + suffix;
      await writeFile(join(directories[kind], name), 'fixture');
      if (aged) await utimes(join(directories[kind], name), old, old);
      return { id, name, kind, path: join(directories[kind], name) };
    }
    async function image(id: string) {
      await writer.query(
        'INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,$2,7,1,1)',
        [id, 'a'.repeat(64)],
      );
    }
    try {
      await root.query('CREATE SCHEMA ' + schema);
      await migrate(url.href);
      await worker.connect();
      await writer.connect();
      await t.test(
        'dry-run retains current/historical metadata, audit-only references, receipts, fresh and unsafe files',
        async () => {
          const icon = await file('icons');
          await writer.query(
            `INSERT INTO catalog_assets(id,sha256,byte_size,width,height,actor_discord_id,created_at,expires_at)
        VALUES($1,$2,7,1,1,'fixture',now()-interval '4 days',now()-interval '3 days')`,
            [icon.id, 'a'.repeat(64)],
          );
          await writer.query(
            'INSERT INTO items(id,name,icon_path,icon_asset_id,active) VALUES(900001,$1,$2,$3,false)',
            ['Historical item', '/api/v1/catalog/icons/' + icon.name, icon.id],
          );
          const logo = await file('branding', '.webp'),
            favicon = await file('branding');
          await writer.query(
            `INSERT INTO clan_logo_assets(id,sha256,byte_size,width,height,favicon_id,favicon_sha256,favicon_byte_size,favicon_width,favicon_height)
        VALUES($1,$2,7,1,1,$3,$2,7,1,1)`,
            [logo.id, 'a'.repeat(64), favicon.id],
          );
          await writer.query(
            'INSERT INTO clan_branding_audit(actor_id,old_logo_asset_id,new_logo_asset_id,version) VALUES($1,$2,NULL,2)',
            ['fixture', logo.id],
          );
          const proof = await file('proofs');
          await image(proof.id);
          const audit = await file('proofs');
          const submission = randomUUID();
          await writer.query(
            `INSERT INTO submissions(id,source,raw_item_text,collector_name,collected_on,date_source,proof_url)
        VALUES($1,'manual','Fixture','Collector',current_date,'collector','')`,
            [submission],
          );
          await writer.query(
            `INSERT INTO audit_events(submission_id,actor_discord_id,action,old_values,new_values)
        VALUES($1,'fixture','edit',$2,'{}')`,
            [
              submission,
              JSON.stringify({
                screenshotPath: '/api/v1/admin/submission-images/' + audit.name,
              }),
            ],
          );
          const receipt = await file('icons');
          await writer.query(
            'INSERT INTO catalog_requests(actor_discord_id,request_key,payload_hash,result) VALUES($1,$2,$3,$4)',
            [
              'fixture',
              randomUUID(),
              'a'.repeat(64),
              JSON.stringify({
                item: { iconPath: '/api/v1/catalog/icons/' + receipt.name },
              }),
            ],
          );
          const fresh = await file('icons', '.webp', randomUUID(), false);
          const orphan = await file('icons');
          const abandonedLogo = await file('branding', '.webp');
          const temp = await file('proofs', '.webp.tmp');
          await writeFile(
            join(directories.proofs, '.clan-api-key.secret'),
            'encryption-root',
          );
          await symlink(
            orphan.path,
            join(directories.icons, randomUUID() + '.webp'),
          );
          const before = await Promise.all(
            Object.values(directories).map((path) => readdir(path)),
          );
          const inspect = await runAssetMaintenance(worker, directories, {
            ...options,
            dryRun: true,
          });
          assert.equal(inspect.eligible, 3);
          assert.equal(inspect.removed, 0);
          assert.equal(inspect.referenced, 6);
          assert.equal(inspect.fresh, 1);
          assert.equal(inspect.unsafe, 1);
          assert.deepEqual(
            await Promise.all(
              Object.values(directories).map((path) => readdir(path)),
            ),
            before,
          );
          assert.equal(
            (
              await worker.query(
                'SELECT count(*)::int n FROM asset_retirements',
              )
            ).rows[0].n,
            0,
          );
          const applied = await runAssetMaintenance(
            worker,
            directories,
            options,
          );
          assert.equal(applied.removed, 3);
          assert.equal(applied.errors, 0);
          for (const retained of [
            icon,
            logo,
            favicon,
            proof,
            audit,
            receipt,
            fresh,
          ])
            assert.equal(await readFile(retained.path, 'utf8'), 'fixture');
          await assert.rejects(readFile(orphan.path));
          await assert.rejects(readFile(abandonedLogo.path));
          await assert.rejects(readFile(temp.path));
          assert.equal(
            await readFile(
              join(directories.proofs, '.clan-api-key.secret'),
              'utf8',
            ),
            'encryption-root',
          );
        },
      );
      await t.test(
        'bounded passes leave remaining files for a safe restart',
        async () => {
          const a = await file('proofs'),
            b = await file('proofs'),
            c = await file('proofs');
          // Restrict traversal to a directory containing only the three candidates.
          const isolated = {
            icons: join(directory, 'empty'),
            branding: join(directory, 'empty-branding'),
            proofs: join(directory, 'batch'),
          };
          await mkdir(isolated.icons);
          await mkdir(isolated.branding);
          await mkdir(isolated.proofs);
          for (const entry of [a, b, c]) {
            await writeFile(join(isolated.proofs, entry.name), 'fixture');
            await utimes(join(isolated.proofs, entry.name), old, old);
          }
          const first = await runAssetMaintenance(worker, isolated, {
            ...options,
            maxFiles: 1,
          });
          assert.equal(first.removed, 1);
          assert.equal((await readdir(isolated.proofs)).length, 2);
          const resumed = await runAssetMaintenance(worker, isolated, options);
          assert.equal(resumed.removed, 2);
          assert.equal((await readdir(isolated.proofs)).length, 0);
          // Retired UUIDs are never reusable, including delayed commits after a lost receipt.
          await assert.rejects(image(a.id), { code: '55000' });
        },
      );
      await t.test(
        'interruption after durable retirement and after unlink is replay-safe',
        async () => {
          const crash = await file('proofs');
          await assert.rejects(
            runAssetMaintenance(worker, directories, options, {
              afterRetirement: async (kind, name) => {
                if (name === crash.name)
                  throw new Error('simulated termination');
              },
            }),
            /simulated termination/,
          );
          assert.equal(await readFile(crash.path, 'utf8'), 'fixture');
          await assert.rejects(image(crash.id), { code: '55000' });
          const report = await runAssetMaintenance(
            worker,
            directories,
            options,
          );
          assert.ok(report.removed >= 1);
          await assert.rejects(readFile(crash.path));
          await worker.query(
            'UPDATE asset_retirements SET removed_at=NULL WHERE storage_kind=$1 AND file_name=$2',
            ['proofs', crash.name],
          );
          const absent = await runAssetMaintenance(
            worker,
            directories,
            options,
          );
          assert.ok(absent.missing >= 1);
          assert.ok(
            (
              await worker.query(
                'SELECT removed_at FROM asset_retirements WHERE storage_kind=$1 AND file_name=$2',
                ['proofs', crash.name],
              )
            ).rows[0].removed_at,
          );
        },
      );
      await t.test(
        'an active committing upload is protected and a late retired upload rolls back',
        async () => {
          const active = await file('proofs');
          await writer.query('BEGIN');
          await image(active.id);
          const whileActive = await runAssetMaintenance(
            worker,
            directories,
            options,
          );
          assert.ok(whileActive.busy > 0);
          assert.equal(await readFile(active.path, 'utf8'), 'fixture');
          await writer.query('COMMIT');
          const after = await runAssetMaintenance(worker, directories, options);
          assert.ok(after.referenced > 0);
          assert.equal(await readFile(active.path, 'utf8'), 'fixture');
          const late = await file('proofs');
          await runAssetMaintenance(worker, directories, options);
          await writer.query('BEGIN');
          await assert.rejects(image(late.id), { code: '55000' });
          await writer.query('ROLLBACK');
          assert.equal(
            (
              await worker.query(
                'SELECT count(*)::int n FROM submission_images WHERE id=$1',
                [late.id],
              )
            ).rows[0].n,
            0,
          );
          await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(image(randomUUID()), { code: '55000' });
          await writer.query('ROLLBACK');
        },
      );
      await t.test(
        'staged expiry is collectible but missing barriers and a second worker fail closed',
        async () => {
          const staged = await file('icons');
          await worker.query(
            `INSERT INTO catalog_assets(id,sha256,byte_size,width,height,actor_discord_id,created_at,expires_at)
        VALUES($1,$2,7,1,1,'fixture',now()-interval '4 days',now()-interval '3 days')`,
            [staged.id, 'a'.repeat(64)],
          );
          await runAssetMaintenance(worker, directories, options);
          await assert.rejects(readFile(staged.path));
          await assert.rejects(
            writer.query(
              'INSERT INTO items(id,name,icon_asset_id) VALUES(900002,$1,$2)',
              ['Late item', staged.id],
            ),
            { code: '55000' },
          );
          await writer.query(
            'SELECT pg_advisory_lock(74261081,hashtext(current_schema()))',
          );
          await assert.rejects(
            runAssetMaintenance(worker, directories, options),
            /Another asset/,
          );
          await writer.query(
            'SELECT pg_advisory_unlock(74261081,hashtext(current_schema()))',
          );
          const keep = await file('proofs');
          await worker.query(
            'ALTER TABLE submission_images DISABLE TRIGGER proof_assets_retirement',
          );
          await assert.rejects(
            runAssetMaintenance(worker, directories, options),
            /asset write barriers/,
          );
          assert.equal(await readFile(keep.path, 'utf8'), 'fixture');
          await worker.query(
            'ALTER TABLE submission_images ENABLE TRIGGER proof_assets_retirement',
          );
        },
      );
      await t.test(
        'replacement between retirement and unlink is retained for investigation',
        async () => {
          const changed = await file('icons');
          const result = await runAssetMaintenance(
            worker,
            directories,
            options,
            {
              afterRetirement: async (kind, name) => {
                if (name === changed.name)
                  await writeFile(changed.path, 'replacement content');
              },
            },
          );
          assert.ok(result.errors > 0);
          assert.equal(
            await readFile(changed.path, 'utf8'),
            'replacement content',
          );
        },
      );
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await worker.end();
      await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

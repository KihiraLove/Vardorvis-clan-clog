import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';
import { importCatalog, readBundledSnapshot } from './catalog-import.js';

test(
  'WebP upgrade preserves live history, recognizes the converted catalog and guards every generated image kind',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'webp_upgrade_' + randomUUID().replaceAll('-', '');
    const root = new pg.Client({ connectionString: url.href });
    await root.connect();
    await root.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema);
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      await client.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    });
    await client.query(
      'CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql') && name < '008_')
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const snapshot = await readBundledSnapshot();
    const legacy = {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        iconPath: item.iconPath.replace('.webp', '.png'),
      })),
    };
    const oldId =
      'sha256:' +
      createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
    assert.equal(
      oldId,
      'sha256:1b71705bb061c341a42c79f5d010af4ae296d33f58cc52c331a680a50e263e32',
    );
    await client.query(
      'INSERT INTO catalog_versions(id,source_url,source_revision) VALUES($1,$2,$3)',
      [oldId, snapshot.source.url, snapshot.source.revision],
    );
    const claim = randomUUID();
    await client.query(`INSERT INTO items(id,name,icon_path) VALUES(1,'Bundled icon','/catalog/items/1249.png'),(2,'Staff override','/custom/kept.webp');
    INSERT INTO staff_accounts(id,username,role,password_hash,must_change_password) VALUES('00000000-0000-4000-8000-000000000001','owner','admin','preserved-hash',false);
    UPDATE site_settings SET clan_name='Live clan',how_to_submit_markdown='Custom help';`);
    await client.query(
      `INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) VALUES($1,'manual','Bundled icon',1,'Collector','2026-10-18','admin','','approved','owner',now())`,
      [claim],
    );
    await client.query(
      `INSERT INTO audit_events(submission_id,actor_discord_id,action,old_values,new_values) VALUES($1,'owner','edit','{}',$2)`,
      [
        claim,
        {
          screenshotPath:
            '/api/v1/admin/submission-images/' + randomUUID() + '.png',
        },
      ],
    );
    const oldRetirement = randomUUID() + '.png';
    await client.query(
      "INSERT INTO asset_retirements(storage_kind,file_name) VALUES('proofs',$1)",
      [oldRetirement],
    );
    const tables = [
      'site_settings',
      'site_settings_audit',
      'staff_accounts',
      'admin_sessions',
      'submissions',
      'collection_credits',
      'audit_events',
      'asset_retirements',
    ];
    const saved = async () => {
      const result: unknown[] = [];
      for (const table of tables)
        result.push(
          (
            await client.query(
              'SELECT to_jsonb(t) row FROM ' +
                table +
                ' t ORDER BY to_jsonb(t)::text',
            )
          ).rows,
        );
      return result;
    };
    const before = await saved();
    const ledger = (
      await client.query('SELECT * FROM schema_migrations ORDER BY name')
    ).rows;
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(await saved(), before);
    assert.deepEqual(
      (
        await client.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows.slice(0, 7),
      ledger,
    );
    assert.deepEqual(
      (await client.query('SELECT icon_path FROM items ORDER BY id')).rows,
      [
        { icon_path: '/catalog/items/1249.webp' },
        { icon_path: '/custom/kept.webp' },
      ],
    );
    assert.equal(await importCatalog(client, snapshot), 'unchanged');
    for (const [kind, target, temporary] of [
      ['icons', 'catalog_assets', false],
      ['icons', 'items', false],
      ['proofs', 'submission_images', false],
      ['branding', 'logo', false],
      ['branding', 'favicon', false],
      ['proofs', 'submission_images', true],
    ] as const) {
      const id = randomUUID();
      await client.query(
        'INSERT INTO asset_retirements(storage_kind,file_name) VALUES($1,$2)',
        [kind, id + '.webp' + (temporary ? '.tmp' : '')],
      );
      let sql: string, values: unknown[];
      if (target === 'items') {
        sql = "INSERT INTO items(id,name,icon_path) VALUES(3,'Retired',$1)";
        values = ['/api/v1/catalog/icons/' + id + '.webp'];
      } else if (target === 'logo' || target === 'favicon') {
        sql =
          'INSERT INTO clan_logo_assets(id,sha256,byte_size,width,height,favicon_id,favicon_sha256,favicon_byte_size,favicon_width,favicon_height) VALUES($1,$2,1,1,1,$3,$2,1,1,1)';
        values = [
          target === 'logo' ? id : randomUUID(),
          'a'.repeat(64),
          target === 'favicon' ? id : randomUUID(),
        ];
      } else {
        sql = `INSERT INTO ${target}(id,sha256,byte_size,width,height${target === 'catalog_assets' ? ',actor_discord_id' : ''}) VALUES($1,$2,1,1,1${target === 'catalog_assets' ? ",'owner'" : ''})`;
        values = [id, 'a'.repeat(64)];
      }
      await assert.rejects(
        client.query(sql, values),
        { code: '55000' },
        target,
      );
    }
  },
);

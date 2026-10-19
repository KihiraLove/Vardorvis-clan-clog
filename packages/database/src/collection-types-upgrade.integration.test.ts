import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';

test(
  'collection type upgrade preserves populated 005 history, receipts, filters and custom copy',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'collection_upgrade_' + randomUUID().replaceAll('-', '');
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
    for (const name of [
      '001_baseline.sql',
      '002_staff_page_access.sql',
      '003_wom_multi_metric.sql',
      '004_permanently_open_pages.sql',
      '005_unmatched_runelite.sql',
    ]) {
      const sql = await readFile(
        new URL('../migrations/' + name, import.meta.url),
        'utf8',
      );
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const normal = randomUUID(),
      hc = randomUUID(),
      pending = randomUUID(),
      rejected = randomUUID();
    await client.query(`INSERT INTO items(id,name) VALUES(1,'Existing item');
    INSERT INTO game_item_ids(game_item_id,item_id) VALUES(900001,1);
    INSERT INTO pages(id,name,category,sort_order) VALUES('page','Existing page','bosses',0);
    INSERT INTO page_items(page_id,item_id,slot) VALUES('page',1,0);
    UPDATE collection_scheduling SET enabled=true,version=9;
    INSERT INTO collection_permanent_pages(page_id) VALUES('page');
    UPDATE submission_filter_settings SET filter_collected=true,version=4;
    UPDATE site_settings SET version=3,public_copy=jsonb_set(public_copy,'{collectionCaption}','"Custom public copy"'),hardcore_copy=jsonb_set(hardcore_copy,'{collectionCaption}','"Custom HC copy"');`);
    for (const [id, status, hardcore] of [
      [normal, 'approved', false],
      [hc, 'approved', true],
      [pending, 'pending', false],
      [rejected, 'rejected', false],
    ] as const)
      await client.query(
        "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,hardcore,status,reviewed_at,reviewed_by,review_reason) VALUES($1,'manual','Existing item',1,'Collector','2026-10-18','admin','',$2,$3,CASE WHEN $3='pending' THEN NULL ELSE now() END,CASE WHEN $3='pending' THEN NULL ELSE 'owner' END,CASE WHEN $3='rejected' THEN 'Historical rejection' ELSE NULL END)",
        [id, hardcore, status],
      );
    await client.query(
      "INSERT INTO audit_events(submission_id,actor_discord_id,actor_name,action,reason,old_values,new_values) VALUES($1,'owner','Owner','approve',NULL,'{}','{\"preserve\":true}')",
      [normal],
    );
    const response = { id: normal, status: 'approved', legacy: true };
    await client.query(
      'INSERT INTO manual_submission_requests(actor_id,request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4,$5)',
      ['owner', randomUUID(), 'a'.repeat(64), normal, JSON.stringify(response)],
    );
    const tables = [
      'submissions',
      'collection_credits',
      'audit_events',
      'manual_submission_requests',
      'collection_scheduling',
      'collection_permanent_pages',
      'submission_filter_settings',
      'site_settings',
    ];
    const snapshot = async () => {
      const result: unknown[] = [];
      for (const table of tables)
        result.push(
          (
            await client.query(
              "SELECT to_jsonb(t)-'collection_type'-'collection_reason'-'how_to_submit_markdown'" +
                (table === 'site_settings' ? "-'version'" : '') +
                ' row FROM ' +
                table +
                ' t ORDER BY to_jsonb(t)::text',
            )
          ).rows,
        );
      return result;
    };
    const before = await snapshot();
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (
        await client.query(
          'SELECT DISTINCT collection_type,collection_reason FROM submissions',
        )
      ).rows,
      [{ collection_type: 'regular', collection_reason: 'legacy' }],
    );
    assert.equal(
      (await client.query('SELECT count(*)::int n FROM collection_credits'))
        .rows[0].n,
      2,
    );
    assert.equal(
      (
        await client.query('SELECT status FROM submissions WHERE id=$1', [
          rejected,
        ])
      ).rows[0].status,
      'rejected',
    );
    await assert.rejects(
      client.query(
        "UPDATE submissions SET collection_type='event' WHERE id=$1",
        [hc],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      client.query('UPDATE submissions SET collection_type=NULL WHERE id=$1', [
        normal,
      ]),
      { code: '23514' },
    );
    await client.query(
      "UPDATE submissions SET collection_type='event' WHERE id=$1",
      [normal],
    );
    await assert.rejects(
      client.query(
        "UPDATE submissions SET collection_type='event',status='approved',reviewed_by='owner',reviewed_at=now() WHERE id=$1",
        [pending],
      ),
      { code: '23505' },
    );
    await client.query(
      "UPDATE submissions SET collection_type='regular',status='approved',reviewed_by='owner',reviewed_at=now() WHERE id=$1",
      [pending],
    );
    assert.equal(
      (await client.query('SELECT count(*)::int n FROM collection_credits'))
        .rows[0].n,
      3,
    );
  },
);

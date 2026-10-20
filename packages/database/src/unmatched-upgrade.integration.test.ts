/** Upgrade populated 004 data through the checksummed production runner. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { migrate } from './migrate.js';

test(
  'unmatched migration backfills drop provenance without changing submissions or immutable receipts',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = 'unmatched_upgrade_' + randomUUID().replaceAll('-', '');
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
    const id = randomUUID(),
      key = randomUUID();
    const response = {
      submissionId: id,
      status: 'approved',
      itemId: 42,
      submittedAt: '2026-10-18T12:00:00.000Z',
      collectedOn: '2026-10-18',
    };
    await client.query(
      "INSERT INTO items(id,name) VALUES(42,'Saved item'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(900001,42)",
    );
    await client.query(
      "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,submitted_clan_name,game_item_id,chat_message,status,reviewed_by,reviewed_at) VALUES($1,'runelite','Saved item',42,'Collector','2026-10-18','submission_default','','Clan',900001,'Original message','approved','owner',now())",
      [id],
    );
    await client.query(
      'INSERT INTO runelite_submission_requests(request_key,payload_hash,submission_id,response) VALUES($1,$2,$3,$4)',
      [key, 'a'.repeat(64), id, JSON.stringify(response)],
    );
    await client.query(
      "INSERT INTO runelite_drop_events(submission_id,player_key,item_id,hardcore,first_received_at,receipt) VALUES($1,'collector',42,false,now(),$2)",
      [id, JSON.stringify(response)],
    );
    const snapshot = async () => ({
      submissions: (
        await client.query(
          "SELECT to_jsonb(s)-'intake_scheduling'-'collection_type'-'collection_reason' row FROM submissions s",
        )
      ).rows,
      requests: (
        await client.query('SELECT * FROM runelite_submission_requests')
      ).rows,
      events: (
        await client.query(
          "SELECT to_jsonb(e)-'game_item_id' row FROM runelite_drop_events e",
        )
      ).rows,
      credits: (
        await client.query(
          "SELECT to_jsonb(c)-'collection_type' row FROM collection_credits c",
        )
      ).rows,
    });
    const before = await snapshot();
    await migrate(url.href);
    await migrate(url.href);
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await client.query(
          'SELECT game_item_id FROM runelite_drop_events WHERE submission_id=$1',
          [id],
        )
      ).rows[0].game_item_id,
      900001,
    );
    assert.equal(
      (
        await client.query(
          'SELECT intake_scheduling FROM submissions WHERE id=$1',
          [id],
        )
      ).rows[0].intake_scheduling,
      null,
    );
    assert.deepEqual(
      (
        await client.query('SELECT name FROM schema_migrations ORDER BY name')
      ).rows.map((row) => row.name),
      (await readdir(new URL('../migrations/', import.meta.url)))
        .filter((name) => name.endsWith('.sql'))
        .sort(),
    );
    const unknown = randomUUID();
    await client.query(
      "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,submitted_clan_name,game_item_id,chat_message) VALUES($1,'runelite','Unlisted',NULL,'Collector','2026-10-18','submission_default','','Clan',999999,'Original message')",
      [unknown],
    );
    await client.query(
      "INSERT INTO runelite_drop_events(submission_id,player_key,item_id,game_item_id,hardcore,first_received_at,receipt) VALUES($1,'collector',NULL,999999,false,now(),'{}')",
      [unknown],
    );
    await assert.rejects(
      client.query(
        'UPDATE runelite_drop_events SET game_item_id=NULL WHERE submission_id=$1',
        [unknown],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      client.query(
        'UPDATE runelite_drop_events SET game_item_id=-1 WHERE submission_id=$1',
        [unknown],
      ),
      { code: '23514' },
    );
    await assert.rejects(
      client.query(
        "UPDATE submissions SET intake_scheduling='[]' WHERE id=$1",
        [unknown],
      ),
      { code: '23514' },
    );
  },
);

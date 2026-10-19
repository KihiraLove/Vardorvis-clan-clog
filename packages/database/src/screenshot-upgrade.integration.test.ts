import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { defaultSubmissionHelp } from '@clog/domain';
import { migrate } from './migrate.js';

for (const custom of [false, true])
  test(
    'screenshot upgrade preserves historical URL claims, receipts and ' +
      (custom ? 'custom help' : 'updates only built-in help'),
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      const schema = 'screenshot_upgrade_' + randomUUID().replaceAll('-', '');
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
        .filter((name) => name.endsWith('.sql') && name < '009_')
        .sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, createHash('sha256').update(sql).digest('hex')],
        );
      }
      if (custom)
        await client.query(
          "UPDATE site_settings SET how_to_submit_markdown='Custom clan instructions'",
        );
      await client.query(`INSERT INTO items(id,name) VALUES(1,'Historical item');
    INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_at,reviewed_by,intake_payload_hash,intake_receipt)
    VALUES('00000000-0000-4000-8000-000000000001','123456789012345678','234567890123456789','345678901234567890','Historical item',1,'Collector','2026-10-18','submission_default','https://imgur.com/historical','approved',now(),'staff',repeat('a',64),'{"original":"immutable receipt"}');
    INSERT INTO audit_events(submission_id,actor_discord_id,action,old_values,new_values) VALUES('00000000-0000-4000-8000-000000000001','staff','approve','{}','{"proofUrl":"https://imgur.com/historical"}');`);
      const snapshot = async () => {
        const rows: unknown[] = [];
        for (const table of [
          'submissions',
          'collection_credits',
          'audit_events',
          'staff_accounts',
          'admin_sessions',
        ])
          rows.push(
            (
              await client.query(
                'SELECT to_jsonb(t) FROM ' +
                  table +
                  ' t ORDER BY to_jsonb(t)::text',
              )
            ).rows,
          );
        return rows;
      };
      const before = await snapshot();
      const settings = (await client.query('SELECT * FROM site_settings'))
        .rows[0];
      const ledger = (
        await client.query('SELECT * FROM schema_migrations ORDER BY name')
      ).rows;
      await migrate(url.href);
      await migrate(url.href);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await client.query('SELECT * FROM schema_migrations ORDER BY name')
        ).rows.slice(0, 8),
        ledger,
      );
      const after = (await client.query('SELECT * FROM site_settings')).rows[0];
      assert.equal(
        after.how_to_submit_markdown,
        custom ? 'Custom clan instructions' : defaultSubmissionHelp,
      );
      assert.equal(after.version, settings.version + (custom ? 0 : 1));
      const image = randomUUID();
      await client.query(
        'INSERT INTO submission_images(id,sha256,byte_size,width,height) VALUES($1,$2,1,1,1)',
        [image, 'b'.repeat(64)],
      );
      await client.query(
        "INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,proof_image_id) VALUES('00000000-0000-4000-8000-000000000002','456789012345678901','234567890123456789','345678901234567890','Screenshot',1,'New collector',current_date,'submission_default','',$1)",
        [image],
      );
      await assert.rejects(
        client.query(
          "INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url) VALUES('00000000-0000-4000-8000-000000000003','456789012345678902','234567890123456789','345678901234567890','No proof',1,'New collector',current_date,'submission_default','')",
        ),
        { code: '23514' },
      );
      // Existing historical records remain manageable; their evidence is never erased.
      await client.query(
        "UPDATE submissions SET review_note='Preserved history' WHERE id='00000000-0000-4000-8000-000000000001'",
      );
    },
  );

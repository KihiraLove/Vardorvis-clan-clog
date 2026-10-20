/** Current schema contracts belong to the fresh release baseline, not retired upgrade paths. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  defaultEventHighlight,
  defaultHardcoreHighlight,
  defaultSiteCopy,
  defaultSubmissionHelp,
} from '@clog/domain';
import { migrate } from './migrate.js';

test(
  'fresh baseline provides current appearance defaults and validates colour/Markdown settings',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    await isolated(t, async (client, url) => {
      const settings = (await client.query('SELECT * FROM site_settings'))
        .rows[0];
      assert.equal(settings.version, 1);
      assert.deepEqual(settings.public_copy, defaultSiteCopy);
      assert.deepEqual(settings.hardcore_copy, defaultSiteCopy);
      assert.equal(settings.how_to_submit_markdown, defaultSubmissionHelp);
      assert.deepEqual(settings.event_highlight, defaultEventHighlight);
      assert.deepEqual(settings.hardcore_highlight, defaultHardcoreHighlight);
      for (const column of ['event_highlight', 'hardcore_highlight']) {
        for (const value of [
          null,
          [],
          {},
          { red: -1, green: 0, blue: 0, alpha: 1 },
          { red: 256, green: 0, blue: 0, alpha: 1 },
          { red: 1.2, green: 0, blue: 0, alpha: 1 },
          { red: 1, green: 2, blue: '3', alpha: 1 },
          { red: 1, green: 2, blue: 3 },
          { red: 1, green: 2, blue: 3, alpha: 1.1 },
          { red: 1, green: 2, blue: 3, alpha: 1, extra: 1 },
        ])
          await assert.rejects(
            client.query('UPDATE site_settings SET ' + column + '=$1', [
              JSON.stringify(value),
            ]),
            { code: '23514' },
          );
        for (const alpha of [0, 0.375, 1]) {
          const colour = { red: 0, green: 255, blue: 128, alpha };
          await client.query('UPDATE site_settings SET ' + column + '=$1', [
            JSON.stringify(colour),
          ]);
          await migrate(url);
          assert.deepEqual(
            (await client.query('SELECT ' + column + ' FROM site_settings'))
              .rows[0][column],
            colour,
          );
        }
      }
      await client.query('UPDATE site_settings SET how_to_submit_markdown=$1', [
        '😀'.repeat(8192),
      ]);
      await assert.rejects(
        client.query('UPDATE site_settings SET how_to_submit_markdown=$1', [
          '😀'.repeat(8193),
        ]),
        { code: '23514' },
      );
      await migrate(url);
      assert.equal(
        (await client.query('SELECT how_to_submit_markdown FROM site_settings'))
          .rows[0].how_to_submit_markdown,
        '😀'.repeat(8192),
      );
    });
  },
);

test(
  'fresh baseline protects WebP assets and temporary files from retired writes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    await isolated(t, async (client) => {
      for (const [kind, target, temporary] of [
        ['icons', 'catalog_assets', false],
        ['icons', 'items', false],
        ['proofs', 'submission_images', false],
        ['proofs', 'submission_images', true],
        ['branding', 'logo', false],
        ['branding', 'favicon', false],
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
    });
  },
);

test(
  'fresh baseline has bounded moderator access, permanent-page references and unmatched drop identities',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    await isolated(t, async (client) => {
      assert.deepEqual(
        (await client.query('SELECT moderator_pages FROM staff_page_access'))
          .rows[0].moderator_pages,
        ['submissions', 'catalog', 'schedules', 'runelite'],
      );
      await assert.rejects(
        client.query(
          "UPDATE staff_page_access SET moderator_pages=ARRAY['unknown']",
        ),
        { code: '23514' },
      );
      await assert.rejects(
        client.query(
          "INSERT INTO collection_permanent_pages(page_id) VALUES('missing')",
        ),
        { code: '23503' },
      );
      await client.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES('event-page','Event page','bosses',0)",
      );
      await client.query(
        "INSERT INTO collection_permanent_pages(page_id) VALUES('event-page')",
      );
      await assert.rejects(
        client.query(
          "INSERT INTO collection_permanent_pages(page_id) VALUES('event-page')",
        ),
        { code: '23505' },
      );
      const submission = randomUUID();
      await client.query(
        "INSERT INTO submissions(id,source,raw_item_text,collector_name,collected_on,date_source,proof_url,game_item_id,submitted_clan_name,chat_message) VALUES($1,'runelite','Unknown drop','Collector',current_date,'submission_default','',999999,'Clan','A drop')",
        [submission],
      );
      const insert =
        "INSERT INTO runelite_drop_events(submission_id,player_key,item_id,hardcore,first_received_at,receipt,game_item_id) VALUES($1,'collector',NULL,false,now(),'{}',$2)";
      await assert.rejects(client.query(insert, [submission, null]), {
        code: '23514',
      });
      await assert.rejects(client.query(insert, [submission, 0]), {
        code: '23514',
      });
      await client.query(insert, [submission, 999999]);
      assert.equal(
        (await client.query('SELECT item_id FROM runelite_drop_events')).rows[0]
          .item_id,
        null,
      );
      await assert.rejects(
        client.query(
          "UPDATE submissions SET status='approved',reviewed_by='staff',reviewed_at=now() WHERE id=$1",
          [submission],
        ),
        { code: '23514' },
      );
    });
  },
);

async function isolated(
  t: import('node:test').TestContext,
  run: (client: pg.Client, url: string) => Promise<void>,
) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const root = new pg.Client({ connectionString: url.href });
  await root.connect();
  const schema = 'baseline_' + randomUUID().replaceAll('-', '');
  await root.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema);
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  t.after(async () => {
    await client.end();
    await root.query('DROP SCHEMA ' + schema + ' CASCADE');
    await root.end();
  });
  await migrate(url.href);
  await run(client, url.href);
}

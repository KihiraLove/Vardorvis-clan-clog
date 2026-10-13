/** Real staff permissions and scheduling gates across RuneLite, Discord and manual intake. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import type { SchedulingState } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import { PgProofStore } from './proof-store.js';
import { ProofStorage } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { PgSchedulingStore, lockScheduling } from './scheduling-store.js';
import { PgRuneLiteSettingsStore } from './runelite-settings.js';
import { hashPassword } from './passwords.js';

test(
  'scheduling is admin-enabled, staff-managed, overlapping and enforced atomically on every new intake',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'schedule_test_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      statement_timeout: 5000,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-schedules-'));
    const backend = new PgStore(pool),
      scheduling = new PgSchedulingStore(pool);
    const proofs = new ProofStorage(directory),
      proofStore = new PgProofStore(pool);
    const runeLiteSettings = new PgRuneLiteSettingsStore(pool);
    const clanKeys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
      bootstrapPassword: 'b'.repeat(64),
    };
    const bot = { token: 'b'.repeat(64), guildId: '100000000000000001' };
    const app = createApp(
      () => backend.ready(),
      () => backend.settings(),
      {
        store: backend,
        scheduling,
        proofs,
        proofStore,
        clanKeys,
        runeLiteSettings,
        review: new PgReviewStore(pool, backend),
        auth,
        bot,
        logger: false,
      },
    );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name) VALUES(1,'Fixture one'),(2,'Fixture two'),(3,'Fixture shared'),(4,'Unpaged'); INSERT INTO game_item_ids SELECT id+900000,id FROM items; INSERT INTO pages(id,name,category,sort_order) VALUES('page-a','Page A','bosses',0),('page-b','Page B','bosses',1); INSERT INTO page_items(page_id,item_id,slot) VALUES('page-a',1,0),('page-a',3,1),('page-b',2,0),('page-b',3,1)",
      );
      await proofs.initialize();
      await clanKeys.ensureDefault();
      await app.ready();
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('schedule-password'),
      );
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('first-password'),
        admin.id,
      );
      const account = (await backend.accountById(mod.id))!;
      await backend.updateAccount(
        mod.id,
        account.credentialVersion,
        'reviewer',
        await hashPassword('review-password'),
      );
      const login = async (username: string, password: string) => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(response.statusCode, 200, response.body);
        return {
          origin: auth.origin,
          cookie: String(response.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': response.json().csrfToken as string,
        };
      };
      const owner = await login('owner', 'schedule-password'),
        moderator = await login('reviewer', 'review-password');
      let state = await scheduling.state();
      assert.deepEqual(state, {
        revision: 'schedules-1',
        enabled: false,
        schedules: [],
      });
      const path = '/api/v1/admin/schedules';
      assert.equal((await app.inject(path)).statusCode, 401);
      assert.equal(
        (await app.inject({ url: path, headers: moderator })).statusCode,
        200,
      );
      const clock = (
        await pool.query<{ at: Date }>('SELECT clock_timestamp() AS at')
      ).rows[0]!.at.getTime();
      const ago = new Date(clock - 3600000).toISOString(),
        later = new Date(clock + 3600000).toISOString();
      const future = new Date(clock + 7200000).toISOString(),
        futureEnd = new Date(clock + 10800000).toISOString();
      const input = {
        title: 'Future A',
        startsAt: future,
        endsAt: futureEnd,
        pageIds: ['page-a'],
      };
      const write = (
        method: 'POST' | 'PUT' | 'DELETE',
        url: string,
        payload: Record<string, unknown>,
        headers = moderator,
      ) => app.inject({ method, url, payload, headers });
      const create = async (fields = input, headers = moderator) => {
        const response = await write(
          'POST',
          path,
          { expectedRevision: state.revision, ...fields },
          headers,
        );
        assert.equal(response.statusCode, 201, response.body);
        state = response.json<SchedulingState>();
        return state.schedules.find((s) => s.title === fields.title)!;
      };
      const toggle = async (enabled: boolean) => {
        const response = await write(
          'PUT',
          path + '/settings',
          { expectedRevision: state.revision, enabled },
          owner,
        );
        assert.equal(response.statusCode, 200, response.body);
        state = response.json<SchedulingState>();
      };
      assert.equal(
        (
          await write('PUT', path + '/settings', {
            expectedRevision: state.revision,
            enabled: true,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await write(
            'POST',
            path,
            { expectedRevision: state.revision, ...input },
            { ...moderator, 'x-csrf-token': 'bad' },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await write('POST', path, {
            expectedRevision: state.revision,
            ...input,
            pageIds: ['missing-page'],
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await write('POST', path, {
            expectedRevision: state.revision,
            ...input,
            endsAt: input.startsAt,
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await write('POST', path, {
            expectedRevision: state.revision,
            ...input,
            startsAt: '2026-02-30T12:00:00.000Z',
          })
        ).statusCode,
        422,
      );
      assert.equal(
        (
          await write('POST', path, {
            expectedRevision: state.revision,
            ...input,
            enabled: true,
          })
        ).statusCode,
        400,
      );
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer();
      const apiKey = (await clanKeys.settings()).key;
      let address = 1,
        interaction = 100000000000000020n;
      const runelite = (
        itemId = 1,
        key = randomUUID(),
        username = 'Collector',
      ) => {
        const boundary = 'schedule-boundary';
        return app.inject({
          method: 'POST',
          url: '/api/v1/runelite/submissions',
          remoteAddress: '192.0.2.' + address++,
          headers: {
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'idempotency-key': key,
            'x-clan-api-key': apiKey,
          },
          payload: Buffer.concat([
            ...Object.entries({
              username,
              clanName: 'Clan name',
              itemId: String(900000 + itemId),
              worldType: 'MEMBERS',
            }).map(([name, value]) =>
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
              ),
            ),
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="proof.png"\r\nContent-Type: image/png\r\n\r\n`,
            ),
            png,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
        });
      };
      const today = new Date(clock).toISOString().slice(0, 10);
      const manual = (itemId = 1, key = randomUUID(), collectedOn = today) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/submissions',
          headers: { ...moderator, 'idempotency-key': key },
          payload: {
            itemId,
            collectorName: 'Staff Player',
            collectedOn,
            hardcore: false,
            approve: false,
          },
        });
      const discord = (
        itemId: number | undefined = 1,
        id = String(interaction++),
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/bot/submissions',
          headers: { authorization: 'Bearer ' + bot.token },
          payload: {
            interactionId: id,
            guildId: bot.guildId,
            actorDiscordId: '100000000000000002',
            rawItemText: itemId ? 'Fixture ' + itemId : 'unmatched thing',
            ...(itemId ? { itemId } : {}),
            collectorName: 'Bot Player',
            proofUrl: 'https://imgur.com/proof',
            hardcore: false,
          },
        });
      const runeKey = randomUUID(),
        manualKey = randomUUID(),
        botId = String(interaction++);
      const initialRune = await runelite(1, runeKey),
        initialManual = await manual(1, manualKey),
        initialBot = await discord(1, botId);
      for (const response of [initialRune, initialManual, initialBot])
        assert.equal(response.statusCode, 201, response.body);
      assert.equal((await runelite(4)).statusCode, 201);
      await create();
      await toggle(true);
      const beforeCounts = (
        await pool.query(
          'SELECT (SELECT count(*)::int FROM submissions) submissions,(SELECT count(*)::int FROM submission_images) images',
        )
      ).rows[0];
      const filesBefore = (await readdir(directory)).filter((name) =>
        name.endsWith('.png'),
      ).length;
      for (const response of [
        await runelite(),
        await manual(),
        await discord(),
        await manual(1, randomUUID(), '2000-01-01'),
        await runelite(4),
        await discord(0),
      ])
        assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT (SELECT count(*)::int FROM submissions) submissions,(SELECT count(*)::int FROM submission_images) images',
          )
        ).rows[0],
        beforeCounts,
      );
      assert.equal(
        (await readdir(directory)).filter((name) => name.endsWith('.png'))
          .length,
        filesBefore,
      );
      assert.deepEqual((await runelite(1, runeKey)).json(), initialRune.json());
      assert.deepEqual(
        (await manual(1, manualKey)).json(),
        initialManual.json(),
      );
      assert.deepEqual((await discord(1, botId)).json(), initialBot.json());
      const openA = await create({
        title: 'Open A',
        startsAt: ago,
        endsAt: later,
        pageIds: ['page-a'],
      });
      const rl = await runeLiteSettings.settings();
      const { revision, ...rules } = rl;
      await runeLiteSettings.update(
        {
          ...rules,
          expectedRevision: revision,
          playerWhitelist: ['Trusted Player'],
          worldPolicies: { ...rules.worldPolicies, members: 'allow' },
        },
        admin.id,
      );
      assert.equal(
        (await runelite(2, randomUUID(), 'Trusted Player')).statusCode,
        403,
      );
      assert.equal(
        (await runelite(1, randomUUID(), 'Trusted Player')).json().status,
        'approved',
      );
      assert.equal((await discord(3)).statusCode, 201); // Shared with a closed page, but A is open.
      assert.equal((await manual(2)).statusCode, 403);
      const both = await create({
        title: 'Both pages',
        startsAt: ago,
        endsAt: later,
        pageIds: ['page-a', 'page-b'],
      });
      assert.equal((await manual(2)).statusCode, 201);
      const removed = await write('DELETE', path + '/' + openA.id, {
        expectedRevision: state.revision,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      state = removed.json();
      assert.equal((await discord(1)).statusCode, 201); // Overlapping window still opens A.
      const edited = await write('PUT', path + '/' + both.id, {
        expectedRevision: state.revision,
        title: both.title,
        pageIds: ['page-a', 'page-b'],
        startsAt: new Date(clock - 7200000).toISOString(),
        endsAt: ago,
      });
      assert.equal(edited.statusCode, 200, edited.body);
      state = edited.json();
      assert.equal((await discord(1)).statusCode, 403); // Past window is closed without a background task.
      const restore = await write('PUT', path + '/' + both.id, {
        expectedRevision: state.revision,
        title: both.title,
        pageIds: ['page-a', 'page-b'],
        startsAt: ago,
        endsAt: later,
      });
      assert.equal(restore.statusCode, 200, restore.body);
      state = restore.json();
      await pool.query("UPDATE pages SET active=false WHERE id='page-b'");
      assert.equal((await manual(2)).statusCode, 403); // Inactive pages never open submissions.
      assert.equal(
        (
          await write('POST', path, {
            expectedRevision: state.revision,
            ...input,
            pageIds: ['page-b'],
          })
        ).statusCode,
        422,
      );
      await pool.query("UPDATE pages SET active=true WHERE id='page-b'");
      assert.equal((await runelite(4)).statusCode, 403);
      const stale = state.revision;
      const races = await Promise.all([
        write('POST', path, {
          expectedRevision: stale,
          ...input,
          title: 'Race one',
        }),
        write('POST', path, {
          expectedRevision: stale,
          ...input,
          title: 'Race two',
        }),
      ]);
      assert.deepEqual(races.map((r) => r.statusCode).sort(), [201, 409]);
      state = races.find((r) => r.statusCode === 201)!.json();
      assert.deepEqual(await new PgSchedulingStore(pool).state(), state);
      assert.equal(
        (
          await write('DELETE', path + '/' + both.id, {
            expectedRevision: stale,
          })
        ).statusCode,
        409,
      );
      await toggle(false);
      assert.equal((await runelite(2)).statusCode, 201);
      assert.equal((await discord(4)).statusCode, 201);
      assert.equal((await discord(0)).json().resolution, 'needs_match');
      assert.ok(state.schedules.length > 0); // Disabling retains all windows.
      assert.ok(
        !JSON.stringify((await app.inject('/api/v1/settings')).json()).includes(
          'schedules',
        ),
      );
      const audit = (
        await pool.query(
          'SELECT actor_id,action FROM collection_schedule_audit ORDER BY id',
        )
      ).rows;
      assert.ok(
        audit.some((row) => row.actor_id === mod.id && row.action === 'create'),
      );
      assert.ok(
        audit.some(
          (row) => row.actor_id === admin.id && row.action === 'enable',
        ),
      );
      await pool.query(
        "CREATE FUNCTION fail_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_schedule_audit BEFORE INSERT ON collection_schedule_audit FOR EACH ROW EXECUTE FUNCTION fail_schedule_audit()",
      );
      assert.equal(
        (
          await write(
            'PUT',
            path + '/settings',
            { expectedRevision: state.revision, enabled: true },
            owner,
          )
        ).statusCode,
        503,
      );
      assert.deepEqual(await scheduling.state(), state);
      await pool.query(
        'DROP TRIGGER fail_schedule_audit ON collection_schedule_audit',
      );
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        assert.equal(await lockScheduling(blocker), false);
        let saved = false;
        const waiting = scheduling
          .setEnabled(true, state.revision, admin.id, 'owner')
          .then((value) => {
            saved = true;
            return value;
          });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(saved, false);
        await blocker.query('COMMIT');
        state = await waiting;
        assert.equal(state.enabled, true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

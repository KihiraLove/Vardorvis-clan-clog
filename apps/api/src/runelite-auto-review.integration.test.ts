/** Exercise private policies, automatic credit, audit rollback and retries in real PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { defaultRuneLiteRules, type RuneLiteSettings } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgProofStore } from './proof-store.js';
import { PgReviewStore } from './review-store.js';
import { ProofStorage } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { PgRuneLiteSettingsStore } from './runelite-settings.js';
import { hashPassword } from './passwords.js';

test(
  'RuneLite auto review settings, world precedence, clan/key modes, whitelist, concurrent credit and atomic replay',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'auto_review_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-auto-review-'));
    const backend = new PgStore(pool),
      proofStore = new PgProofStore(pool);
    const proofs = new ProofStorage(directory);
    const clanKeys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    const settings = new PgRuneLiteSettingsStore(pool);
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
    };
    const app = createApp(
      () => backend.ready(),
      () => backend.settings(),
      {
        store: backend,
        review: new PgReviewStore(pool, backend),
        proofs,
        proofStore,
        runeLiteSettings: settings,
        clanKeys,
        auth,
        logger: false,
      },
    );
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const file of (await readdir(migrations))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name) SELECT i,'Fixture '||i FROM generate_series(1,30) i; INSERT INTO game_item_ids SELECT 900000+id,id FROM items",
      );
      await proofs.initialize();
      await clanKeys.ensureDefault();
      await app.ready();
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('review-password'),
      );
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('first-password'),
        admin.id,
      );
      const modAccount = (await backend.accountById(mod.id))!;
      await backend.updateAccount(
        mod.id,
        modAccount.credentialVersion,
        'reviewer',
        await hashPassword('next-password'),
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
      const owner = await login('owner', 'review-password'),
        moderator = await login('reviewer', 'next-password');
      let rules = await settings.settings();
      assert.deepEqual(rules, {
        revision: 'runelite-1',
        ...defaultRuneLiteRules('Clan name'),
      });
      const path = '/api/v1/admin/runelite-settings';
      assert.equal((await app.inject(path)).statusCode, 401);
      assert.equal(
        (await app.inject({ url: path, headers: moderator })).statusCode,
        403,
      );
      const update = (payload: unknown, headers = owner) =>
        app.inject({
          method: 'PUT',
          url: path,
          headers,
          payload: payload as Record<string, unknown>,
        });
      const fields = () => {
        const { revision, ...rest } = rules;
        return { expectedRevision: revision, ...rest };
      };
      assert.equal((await update(fields(), moderator)).statusCode, 403);
      assert.equal(
        (await update(fields(), { ...owner, 'x-csrf-token': 'bad' }))
          .statusCode,
        403,
      );
      assert.equal(
        (await update({ ...fields(), surprise: true })).statusCode,
        400,
      );
      assert.equal(
        (await update({ ...fields(), matchClanName: 'false' })).statusCode,
        400,
      );
      assert.equal(
        (
          await update({
            ...fields(),
            worldPolicies: { ...rules.worldPolicies, members: 'reject' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await update({ ...fields(), clanName: 'Bad\nClan' })).statusCode,
        422,
      );
      assert.equal(
        (
          await update({
            ...fields(),
            playerWhitelist: Array.from({ length: 201 }, () => 'Player'),
          })
        ).statusCode,
        400,
      );
      const save = async (changes: Partial<RuneLiteSettings> = {}) => {
        const response = await update({ ...fields(), ...changes });
        assert.equal(response.statusCode, 200, response.body);
        rules = response.json();
      };
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer();
      const apiKey = (await clanKeys.settings()).key;
      let address = 1;
      const submit = (
        worldType: string,
        itemId = 1,
        username = 'Collector',
        clanName = 'Clan name',
        key = randomUUID(),
        credential: string | undefined = apiKey,
      ) => {
        const boundary = 'auto-review-boundary';
        return app.inject({
          method: 'POST',
          url: '/api/v1/runelite/submissions',
          remoteAddress: '192.0.2.' + address++,
          headers: {
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'idempotency-key': key,
            ...(credential === undefined
              ? {}
              : { 'x-clan-api-key': credential }),
          },
          payload: Buffer.concat([
            ...Object.entries({
              worldType,
              username,
              clanName,
              itemId: String(900000 + itemId),
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
      assert.equal((await submit('MEMBERS')).json().status, 'pending');
      await save({
        clanName: 'Game Clan',
        playerWhitelist: [' Trusted_Player ', 'trusted player'],
      });
      assert.deepEqual(rules.playerWhitelist, ['trusted player']);
      assert.equal((await submit('MEMBERS')).statusCode, 403);
      assert.equal(
        (await submit('MEMBERS', 1, 'Collector', ' game clan ')).statusCode,
        201,
      );
      const publicSettings = (await app.inject('/api/v1/settings')).json();
      assert.equal(publicSettings.clanName, 'Clan name');
      assert.ok(!JSON.stringify(publicSettings).includes('trusted player'));
      assert.ok(!JSON.stringify(publicSettings).includes('worldPolicies'));
      const blockedCount = (
        await pool.query('SELECT count(*)::int n FROM submissions')
      ).rows[0].n;
      for (const flag of [
        'BETA_WORLD',
        'DEADMAN',
        'NOSAVE_MODE',
        'PVP_ARENA',
        'QUEST_SPEEDRUNNING',
        'SEASONAL',
        'TOURNAMENT',
        'TOURNAMENT_WORLD',
      ])
        assert.equal(
          (
            await submit(
              JSON.stringify(['MEMBERS', flag]),
              2,
              'Trusted Player',
              'Game Clan',
            )
          ).statusCode,
          403,
        );
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM submissions')).rows[0].n,
        blockedCount,
      );
      const trusted = await submit('MEMBERS', 2, 'TRUSTED_PLAYER', 'Game Clan');
      assert.equal(trusted.statusCode, 201, trusted.body);
      assert.equal(trusted.json().status, 'approved');
      const detail = (
        await app.inject({
          url: '/api/v1/admin/submissions/' + trusted.json().submissionId,
          headers: moderator,
        })
      ).json();
      assert.equal(detail.submission.status, 'approved');
      assert.equal(detail.audit[0].actorName, 'RuneLite auto review');
      assert.equal(detail.audit[0].action, 'approve');
      assert.equal(detail.audit[0].before.status, 'pending');
      assert.equal(detail.audit[0].after.version, 2);
      assert.match(detail.audit[0].reason, /whitelist/u);
      await save({
        worldPolicies: {
          f2p: 'reject',
          pvp: 'reject',
          members: 'allow',
          hardcore: 'review',
        },
      });
      for (const flag of ['F2P', 'PVP'])
        assert.equal(
          (
            await submit(
              JSON.stringify(['MEMBERS', flag]),
              3,
              'trusted player',
              'Game Clan',
            )
          ).statusCode,
          403,
        );
      assert.equal(
        (await submit('MEMBERS', 3, 'Collector', 'Game Clan')).json().status,
        'approved',
      );
      assert.equal(
        (
          await submit(
            '["MEMBERS","HC_WORLDS_PLACEHOLDER"]',
            3,
            'Collector',
            'Game Clan',
          )
        ).json().status,
        'pending',
      );
      await save({
        worldPolicies: {
          f2p: 'allow',
          pvp: 'review',
          members: 'allow',
          hardcore: 'allow',
        },
      });
      assert.equal(
        (await submit('["MEMBERS","PVP"]', 4, 'Collector', 'Game Clan')).json()
          .status,
        'pending',
      );
      assert.equal(
        (
          await submit('["MEMBERS","PVP"]', 4, 'Trusted Player', 'Game Clan')
        ).json().status,
        'approved',
      );
      assert.equal(
        (await submit('F2P', 5, 'Collector', 'Game Clan')).json().status,
        'approved',
      );
      await save({
        worldPolicies: {
          f2p: 'review',
          pvp: 'allow',
          members: 'allow',
          hardcore: 'allow',
        },
      });
      assert.equal(
        (await submit('F2P', 6, 'Collector', 'Game Clan')).json().status,
        'pending',
      );
      assert.equal(
        (await submit('PVP', 6, 'Collector', 'Game Clan')).json().status,
        'approved',
      );
      for (const flag of ['HC_WORLD_PLACEHOLDER', 'HC_WORLDS_PLACEHOLDER']) {
        const result = await submit(
          flag,
          flag === 'HC_WORLD_PLACEHOLDER' ? 7 : 8,
          'Collector',
          'Game Clan',
        );
        assert.equal(result.json().status, 'approved', result.body);
        assert.equal(result.json().hardcore, true);
      }
      assert.equal(
        (await submit('NORMAL', 9, 'Collector', 'Game Clan')).json().status,
        'pending',
      );
      await save({ matchClanName: false });
      const keyOnly = await submit('MEMBERS', 9, 'Collector', 'Different Clan');
      assert.equal(keyOnly.json().status, 'approved', keyOnly.body);
      const keySettings = await clanKeys.settings();
      await clanKeys.update(
        { expectedRevision: keySettings.revision, enabled: false },
        admin.id,
      );
      assert.equal(
        (
          await submit(
            'MEMBERS',
            10,
            'Collector',
            'Other',
            randomUUID(),
            'bad-key!',
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (await submit('MEMBERS', 10, 'Collector', 'Other')).json().status,
        'approved',
      );
      await save({ matchClanName: true });
      const concurrent = await Promise.all(
        Array.from({ length: 3 }, () =>
          submit('MEMBERS', 11, 'Collector', 'Game Clan'),
        ),
      );
      assert.deepEqual(concurrent.map((r) => r.json().status).sort(), [
        'approved',
        'pending',
        'pending',
      ]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM submissions WHERE item_id=11 AND status='approved'",
          )
        ).rows[0].n,
        1,
      );
      const deferred = concurrent.find((r) => r.json().status === 'pending')!;
      assert.match(
        (
          await pool.query(
            'SELECT reason FROM audit_events WHERE submission_id=$1',
            [deferred.json().submissionId],
          )
        ).rows[0].reason,
        /deferred/u,
      );
      const replayKey = randomUUID();
      const original = await submit(
        'MEMBERS',
        12,
        'Collector',
        'Game Clan',
        replayKey,
      );
      assert.equal(original.json().status, 'approved');
      await save({
        worldPolicies: { ...rules.worldPolicies, members: 'review' },
      });
      assert.deepEqual(
        (
          await submit('MEMBERS', 12, 'Collector', 'Game Clan', replayKey)
        ).json(),
        original.json(),
      );
      assert.equal(
        (await submit('MEMBERS', 13, 'Collector', 'Game Clan', replayKey))
          .statusCode,
        409,
      );
      await save({
        worldPolicies: { ...rules.worldPolicies, members: 'allow' },
      });
      await pool.query(
        "CREATE FUNCTION fail_auto_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_discord_id='system:runelite-auto-review' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_auto_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_auto_audit()",
      );
      const failedKey = randomUUID();
      assert.equal(
        (await submit('MEMBERS', 14, 'Collector', 'Game Clan', failedKey))
          .statusCode,
        503,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM submissions WHERE item_id=14',
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM runelite_submission_requests WHERE request_key=$1',
            [failedKey],
          )
        ).rows[0].n,
        0,
      );
      await pool.query('DROP TRIGGER fail_auto_audit ON audit_events');
      assert.equal(
        (
          await submit('MEMBERS', 14, 'Collector', 'Game Clan', failedKey)
        ).json().status,
        'approved',
      );
      assert.equal(
        (await update({ ...fields(), expectedRevision: 'runelite-1' }))
          .statusCode,
        409,
      );
      assert.ok(
        (
          await pool.query(
            'SELECT count(*)::int n FROM runelite_settings_audit',
          )
        ).rows[0].n > 0,
      );
      await pool.query(
        "CREATE FUNCTION fail_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_settings_audit BEFORE INSERT ON runelite_settings_audit FOR EACH ROW EXECUTE FUNCTION fail_settings_audit()",
      );
      assert.equal(
        (await update({ ...fields(), clanName: 'Unsaved' })).statusCode,
        503,
      );
      assert.deepEqual(await settings.settings(), rules);
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

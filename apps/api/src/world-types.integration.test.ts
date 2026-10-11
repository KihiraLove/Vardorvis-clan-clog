/** World flags, arbitrary keys and replay mode are exercised through real multipart intake. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { blockedRuneLiteWorldTypes } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import { PgProofStore } from './proof-store.js';
import { ProofStorage } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { hashPassword } from './passwords.js';

test(
  'RuneLite blocks excluded world flags, isolates HC credit, preserves arbitrary keys and binds replays to the world set',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    const schema = 'world_intake_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-world-intake-'));
    const backend = new PgStore(pool),
      review = new PgReviewStore(pool, backend);
    const proofs = new ProofStorage(directory),
      proofStore = new PgProofStore(pool);
    const clanKeys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
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
        review,
        proofStore,
        proofs,
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
        "INSERT INTO items(id,name) VALUES(42,'World fixture'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(900001,42)",
      );
      await proofs.initialize();
      await clanKeys.ensureDefault();
      await app.ready();
      let keys = await clanKeys.settings();
      let keyHeaders: Record<string, string> = { 'x-clan-api-key': keys.key };
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('world-test-password'),
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: auth.origin },
        payload: { username: 'owner', password: 'world-test-password' },
      });
      assert.equal(login.statusCode, 200, login.body);
      const owner = {
        origin: auth.origin,
        cookie: String(login.headers['set-cookie']).split(';')[0]!,
        'x-csrf-token': login.json().csrfToken as string,
      };
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer();
      let address = 1;
      const run = (worldType: string | undefined, key = randomUUID()) => {
        const boundary = 'world-boundary';
        const fields = [
          ['username', 'Collector'],
          ['clanName', 'Clan name'],
          ['itemId', '900001'],
        ];
        if (worldType !== undefined) fields.push(['worldType', worldType]);
        return app.inject({
          method: 'POST',
          url: '/api/v1/runelite/submissions',
          remoteAddress: '192.0.2.' + address++,
          headers: {
            'content-type': 'multipart/form-data; boundary=' + boundary,
            'idempotency-key': key,
            ...keyHeaders,
          },
          payload: Buffer.concat([
            ...fields.map(([name, value]) =>
              Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
              ),
            ),
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="world.png"\r\nContent-Type: image/png\r\n\r\n`,
            ),
            png,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
        });
      };
      for (const blocked of blockedRuneLiteWorldTypes) {
        for (const world of [
          blocked,
          JSON.stringify(['MEMBERS', 'HC_WORLD_PLACEHOLDER', blocked]),
        ]) {
          const rejected = await run(world);
          assert.equal(rejected.statusCode, 403, rejected.body);
          assert.match(rejected.json().error, new RegExp(blocked));
        }
      }
      assert.equal((await run(undefined)).statusCode, 400);
      for (const invalid of [
        '',
        'deadman',
        '[',
        '{}',
        '[null]',
        '["MEMBERS",2]',
        '["DEADMAN "]',
        JSON.stringify(Array(33).fill('MEMBERS')),
      ])
        assert.equal((await run(invalid)).statusCode, 422, invalid);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM submissions')).rows[0]
          .n,
        0,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM submission_images'))
          .rows[0].n,
        0,
      );
      assert.equal(
        (await readdir(directory)).filter((file) => file.endsWith('.png'))
          .length,
        0,
      );

      const ordinaryTypes = [
        '[]',
        'NORMAL',
        'MEMBERS',
        'PVP',
        'BOUNTY',
        'SKILL_TOTAL',
        'HIGH_RISK',
        'LAST_MAN_STANDING',
        'LEGACY_ONLY',
        'EOC_ONLY',
        'FRESH_START_WORLD',
        'FUTURE_WORLD_TYPE',
      ];
      let ordinaryId = '';
      for (const type of ordinaryTypes) {
        const result = await run(type);
        assert.equal(result.statusCode, 201, result.body);
        assert.equal(result.json().hardcore, false, type);
        assert.equal(result.json().status, 'pending');
        ordinaryId ||= result.json().submissionId as string;
      }
      const singleHC = await run('HC_WORLD_PLACEHOLDER');
      assert.equal(singleHC.statusCode, 201, singleHC.body);
      assert.equal(singleHC.json().hardcore, true);
      const key = randomUUID();
      const hc = await run(
        '["MEMBERS","HC_WORLD_PLACEHOLDER","SKILL_TOTAL"]',
        key,
      );
      assert.equal(hc.statusCode, 201, hc.body);
      const receipt = hc.json();
      assert.equal(receipt.hardcore, true);
      assert.deepEqual(
        (
          await run(
            '["SKILL_TOTAL","MEMBERS","HC_WORLD_PLACEHOLDER","MEMBERS"]',
            key,
          )
        ).json(),
        receipt,
      );
      assert.equal(
        (await run('["MEMBERS","SKILL_TOTAL"]', key)).statusCode,
        409,
      );
      assert.equal(
        (await run('["HC_WORLD_PLACEHOLDER","DEADMAN"]', key)).statusCode,
        403,
      );
      const saved = (
        await pool.query(
          'SELECT hardcore,submitted_world_types FROM submissions WHERE id=$1',
          [receipt.submissionId],
        )
      ).rows[0];
      assert.deepEqual(saved, {
        hardcore: true,
        submitted_world_types: [
          'HC_WORLD_PLACEHOLDER',
          'MEMBERS',
          'SKILL_TOTAL',
        ],
      });
      assert.equal((await backend.settings()).hardcoreEnabled, false);
      for (const id of [ordinaryId, receipt.submissionId]) {
        const approved = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/submissions/' + id + '/approve',
          headers: owner,
          payload: { expectedVersion: 1 },
        });
        assert.equal(approved.statusCode, 200, approved.body);
      }
      const credits = (await app.inject('/api/v1/collections')).json()
        .credits as { itemId: number; hardcore: boolean }[];
      assert.deepEqual(credits.map((credit) => credit.hardcore).sort(), [
        false,
        true,
      ]);
      assert.ok(credits.every((credit) => credit.itemId === 42));
      assert.deepEqual(
        (
          await run('["HC_WORLD_PLACEHOLDER","MEMBERS","SKILL_TOTAL"]', key)
        ).json(),
        receipt,
      );

      // Pre-world-type receipts stay immutable and replay only as ordinary-world input.
      const legacyKey = randomUUID();
      const legacy = await run('MEMBERS', legacyKey);
      assert.equal(legacy.statusCode, 201, legacy.body);
      const image = (
        await pool.query(
          'SELECT i.sha256 FROM submissions s JOIN submission_images i ON i.id=s.proof_image_id WHERE s.id=$1',
          [legacy.json().submissionId],
        )
      ).rows[0];
      const legacyHash = createHash('sha256')
        .update(
          JSON.stringify(['Collector', 'clan name', 900001, image.sha256]),
        )
        .digest('hex');
      await pool.query(
        'UPDATE submissions SET submitted_world_types=NULL WHERE id=$1',
        [legacy.json().submissionId],
      );
      await pool.query(
        "UPDATE runelite_submission_requests SET payload_hash=$1,response=response-'hardcore' WHERE request_key=$2",
        [legacyHash, legacyKey],
      );
      const original = { ...legacy.json() };
      delete original.hardcore;
      assert.deepEqual((await run('MEMBERS', legacyKey)).json(), original);
      assert.equal(
        (await run('HC_WORLD_PLACEHOLDER', legacyKey)).statusCode,
        409,
      );

      // Headers encode keys that cannot be represented literally in HTTP.
      for (const custom of [
        'eight!!!',
        '  symbols! +  ',
        '符号 😀\n\u0000 key',
        '\uFEFFbom key!!',
        'a'.repeat(500),
      ]) {
        const update = await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/clan-api-key',
          headers: owner,
          payload: { expectedRevision: keys.revision, key: custom },
        });
        assert.equal(update.statusCode, 200, update.body);
        keys = update.json();
        assert.equal(keys.key, custom);
        await new PgClanKeyStore(
          pool,
          await loadClanKeyRoot(directory),
        ).ensureDefault();
        assert.deepEqual(await clanKeys.settings(), keys);
        keyHeaders = {
          'x-clan-api-key-base64': Buffer.from(custom).toString('base64url'),
        };
        assert.equal((await run('MEMBERS')).statusCode, 201);
        keyHeaders = {
          'x-clan-api-key-base64': Buffer.from(custom + 'wrong').toString(
            'base64url',
          ),
        };
        assert.equal((await run('MEMBERS')).statusCode, 401);
      }
      keys = await clanKeys.update(
        { expectedRevision: keys.revision, enabled: false },
        admin.id,
      );
      keyHeaders = { 'x-clan-api-key-base64': 'invalid!' };
      assert.equal((await run('MEMBERS')).statusCode, 201);
      assert.equal((await run('BETA_WORLD')).statusCode, 403);
      assert.equal((await clanKeys.settings()).key, keys.key);
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

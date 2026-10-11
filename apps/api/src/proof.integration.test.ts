/** Real multipart intake, private storage, staff review and transactional replay in disposable PostgreSQL. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import { PgProofStore } from './proof-store.js';
import { ProofStorage, MAX_SCREENSHOT_BYTES } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { hashPassword } from './passwords.js';

test(
  'RuneLite clan validation, canonical IDs, retries, optional manual PNGs, private reads and moderator review',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
    });
    const schema = 'proof_test_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-proofs-'));
    const backend = new PgStore(pool),
      review = new PgReviewStore(pool, backend),
      store = new PgProofStore(pool),
      proofs = new ProofStorage(directory);
    const clanKeys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    let apiKey: string | undefined;
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
        proofs,
        proofStore: store,
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
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name) VALUES(42,'Canonical fixture'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(900001,42),(900002,42)",
      );
      await proofs.initialize();
      await clanKeys.ensureDefault();
      apiKey = (await clanKeys.settings()).key;
      await app.ready();
      const admin = (await backend.accountByUsername('admin'))!;
      await backend.updateAccount(
        admin.id,
        admin.credentialVersion,
        'owner',
        await hashPassword('owner-password'),
      );
      const mod = await backend.createModerator(
        'reviewer',
        await hashPassword('moderator-password'),
        admin.id,
      );
      const modAccount = (await backend.accountById(mod.id))!;
      await backend.updateAccount(
        mod.id,
        modAccount.credentialVersion,
        'reviewer',
        await hashPassword('moderator-new-password'),
      );
      const login = async (username: string, password: string) => {
        const r = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: auth.origin },
          payload: { username, password },
        });
        assert.equal(r.statusCode, 200, r.body);
        return {
          origin: auth.origin,
          cookie: String(r.headers['set-cookie']).split(';')[0]!,
          'x-csrf-token': r.json().csrfToken as string,
        };
      };
      const owner = await login('owner', 'owner-password'),
        moderator = await login('reviewer', 'moderator-new-password');
      const png = await sharp({
        create: {
          width: 1024,
          height: 768,
          channels: 3,
          background: '#223344',
        },
      })
        .png()
        .toBuffer();
      const multipart = (
        fields: [string, string][],
        bytes = png,
        mime = 'image/png',
        fileFirst = false,
      ) => {
        const boundary = 'proof-boundary';
        const file = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="../../untrusted.png"\r\nContent-Type: ${mime}\r\n\r\n`,
          ),
          bytes,
          Buffer.from('\r\n'),
        ]);
        const texts = fields.map(([name, value]) =>
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          ),
        );
        return {
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: Buffer.concat([
            ...(fileFirst ? [file, ...texts] : [...texts, file]),
            Buffer.from(`--${boundary}--\r\n`),
          ]),
        };
      };
      let address = 1;
      const runelite = (
        fields: [string, string][],
        bytes = png,
        key?: string,
        mime = 'image/png',
        first = false,
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/runelite/submissions',
          remoteAddress: '192.0.2.' + address++,
          ...multipart(fields, bytes, mime, first),
          headers: {
            ...multipart(fields).headers,
            ...(key ? { 'idempotency-key': key } : {}),
            ...(apiKey === undefined ? {} : { 'x-clan-api-key': apiKey }),
          },
        });
      const fields: [string, string][] = [
        ['username', 'Collector'],
        ['clanName', ' clan name '],
        ['itemId', '900001'],
      ];
      const generated = apiKey!;
      assert.match(generated, /^[a-f0-9]{32}$/u);
      apiKey = undefined;
      assert.equal((await runelite(fields)).statusCode, 401);
      apiKey = 'wrong-key';
      assert.equal((await runelite(fields)).statusCode, 401);
      apiKey = generated;
      assert.equal(
        (await app.inject('/api/v1/admin/clan-api-key')).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/clan-api-key',
            headers: moderator,
          })
        ).statusCode,
        403,
      );
      const initialKey = await app.inject({
        url: '/api/v1/admin/clan-api-key',
        headers: owner,
      });
      assert.equal(initialKey.statusCode, 200, initialKey.body);
      assert.deepEqual(initialKey.json(), {
        revision: 'clan-key-1',
        enabled: true,
        key: generated,
      });
      assert.equal(initialKey.headers['cache-control'], 'no-store');
      const publicSettings = (await app.inject('/api/v1/settings')).body;
      assert.ok(
        !publicSettings.includes(generated) &&
          !publicSettings.includes('apiKey'),
      );
      await Promise.all(
        Array.from({ length: 8 }, () => clanKeys.ensureDefault()),
      );
      assert.equal((await clanKeys.settings()).key, generated);
      const encrypted = (
        await pool.query('SELECT encrypted_key FROM clan_api_keys')
      ).rows[0].encrypted_key as string;
      assert.ok(encrypted.startsWith('v1:') && !encrypted.includes(generated));
      assert.equal(
        (
          await runelite(
            fields.map(([k, v]) => [k, k === 'clanName' ? 'Other' : v]),
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await runelite(fields, Buffer.from('bad'))).statusCode,
        400,
      );
      assert.equal(
        (await runelite(fields, png, undefined, 'image/jpeg')).statusCode,
        400,
      );
      assert.equal(
        (
          await runelite([
            ['username', 'First'],
            ['username', 'Duplicate'],
            ['clanName', 'Clan name'],
          ])
        ).statusCode,
        400,
      );
      assert.equal(
        (await runelite(fields.map(([k, v]) => [k, k === 'itemId' ? '42' : v])))
          .statusCode,
        422,
      );
      assert.equal(
        (await runelite(fields, Buffer.alloc(MAX_SCREENSHOT_BYTES + 1)))
          .statusCode,
        413,
      );
      assert.equal(
        (await readdir(directory)).filter((file) => file.endsWith('.png'))
          .length,
        0,
      );
      const key = randomUUID();
      const responses = await Promise.all([
        runelite(fields, png, key, 'image/png', true),
        runelite(fields, png, key),
      ]);
      for (const r of responses) assert.equal(r.statusCode, 201, r.body);
      assert.deepEqual(responses[0]!.json(), responses[1]!.json());
      const receipt = responses[0]!.json();
      assert.equal(receipt.status, 'pending');
      assert.equal(receipt.itemId, 42);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM submissions')).rows[0]
          .n,
        1,
      );
      assert.equal(
        (await readdir(directory)).filter((file) => file.endsWith('.png'))
          .length,
        1,
      );
      assert.equal(
        (
          await runelite(
            fields.map(([k, v]) => [k, k === 'username' ? 'Other' : v]),
            png,
            key,
          )
        ).statusCode,
        409,
      );
      const detail = (
        await app.inject({
          url: '/api/v1/admin/submissions/' + receipt.submissionId,
          headers: moderator,
        })
      ).json();
      assert.equal(detail.submission.source, 'runelite');
      const imagePath = detail.submission.screenshotPath as string;
      assert.equal((await app.inject(imagePath)).statusCode, 401);
      const image = await app.inject({ url: imagePath, headers: moderator });
      assert.equal(image.statusCode, 200, image.body);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.match(image.headers['cache-control']!, /no-store/u);
      await new ProofStorage(directory).initialize();
      assert.equal(
        (await app.inject({ url: imagePath, headers: owner })).statusCode,
        200,
      );
      const approved = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/submissions/' + receipt.submissionId + '/approve',
        headers: moderator,
        payload: { expectedVersion: 1 },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      const publicBody = (await app.inject('/api/v1/collections')).body;
      assert.ok(
        !publicBody.includes('screenshot') &&
          !publicBody.includes('proof') &&
          !publicBody.includes('clanName'),
      );
      assert.equal(JSON.parse(publicBody).credits.length, 1);
      assert.deepEqual((await runelite(fields, png, key)).json(), receipt); // replay remains the original pending receipt
      const manual = {
        itemId: 42,
        collectorName: 'Manual',
        collectedOn: receipt.collectedOn,
        hardcore: true,
        approve: false,
      };
      const upload = multipart([['submission', JSON.stringify(manual)]]),
        manualKey = randomUUID();
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/submissions/upload',
            ...upload,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/submissions/upload',
            ...upload,
            headers: { ...upload.headers, cookie: moderator.cookie },
          })
        ).statusCode,
        403,
      );
      const create = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/submissions/upload',
          ...upload,
          headers: {
            ...upload.headers,
            ...moderator,
            'idempotency-key': manualKey,
          },
        });
      const created = await create();
      assert.equal(created.statusCode, 201, created.body);
      assert.deepEqual((await create()).json(), created.json());
      assert.equal(
        (await readdir(directory)).filter((file) => file.endsWith('.png'))
          .length,
        2,
      );
      const noImage = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/submissions',
        headers: { ...moderator, 'idempotency-key': randomUUID() },
        payload: manual,
      });
      assert.equal(noImage.statusCode, 201, noImage.body);
      assert.equal(noImage.json().screenshotPath, null);
      const keyUpdate = async (
        changes: { enabled?: boolean; key?: string; generate?: true },
        headers = owner,
        revision?: string,
      ) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/admin/clan-api-key',
          headers,
          payload: {
            expectedRevision: revision ?? (await clanKeys.settings()).revision,
            ...changes,
          },
        });
      assert.equal(
        (await keyUpdate({ generate: true }, moderator)).statusCode,
        403,
      );
      assert.equal(
        (
          await keyUpdate({ generate: true }, {
            cookie: owner.cookie,
          } as typeof owner)
        ).statusCode,
        403,
      );
      assert.equal(
        (await keyUpdate({ generate: true, key: 'both-conflict' })).statusCode,
        422,
      );
      assert.equal((await keyUpdate({ key: '   ' })).statusCode, 422);
      const custom = '0123456789abcdef0123456789abcdef';
      const rotated = await keyUpdate({ key: custom });
      assert.equal(rotated.statusCode, 200, rotated.body);
      assert.equal(rotated.json().key, custom);
      assert.equal((await runelite(fields, png, key)).statusCode, 401); // old generated key
      apiKey = custom;
      assert.deepEqual((await runelite(fields, png, key)).json(), receipt);
      assert.equal(
        (await keyUpdate({ generate: true }, owner, 'clan-key-1')).statusCode,
        409,
      );
      const disabled = await keyUpdate({ enabled: false });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(disabled.json().key, custom);
      apiKey = undefined;
      assert.deepEqual((await runelite(fields, png, key)).json(), receipt);
      apiKey = 'ignored-while-disabled';
      assert.deepEqual((await runelite(fields, png, key)).json(), receipt);
      assert.equal(
        (
          await runelite(
            fields.map(([k, v]) => [k, k === 'clanName' ? 'Other' : v]),
          )
        ).statusCode,
        403,
      );
      const generatedWhileOff = await keyUpdate({ generate: true });
      assert.equal(generatedWhileOff.statusCode, 200, generatedWhileOff.body);
      assert.equal(generatedWhileOff.json().enabled, false);
      assert.notEqual(generatedWhileOff.json().key, custom);
      const customWhileOff = await keyUpdate({
        key: 'fedcba9876543210fedcba9876543210',
      });
      assert.equal(customWhileOff.statusCode, 200, customWhileOff.body);
      assert.equal(customWhileOff.json().enabled, false);
      assert.equal(
        customWhileOff.json().key,
        'fedcba9876543210fedcba9876543210',
      );
      await new PgClanKeyStore(
        pool,
        await loadClanKeyRoot(directory),
      ).ensureDefault();
      assert.deepEqual(await clanKeys.settings(), customWhileOff.json());
      const enabledKey = await keyUpdate({ enabled: true });
      assert.equal(enabledKey.statusCode, 200, enabledKey.body);
      assert.equal(enabledKey.json().key, customWhileOff.json().key);
      apiKey = undefined;
      assert.equal((await runelite(fields, png, key)).statusCode, 401);
      apiKey = enabledKey.json().key;
      assert.deepEqual((await runelite(fields, png, key)).json(), receipt);
      // Rotate after the onRequest check but before transaction validation: no claim or file commits.
      const createRuneLite = store.createRuneLite.bind(store);
      store.createRuneLite = async (...args) => {
        await clanKeys.update(
          {
            expectedRevision: (await clanKeys.settings()).revision,
            generate: true,
          },
          admin.id,
        );
        return createRuneLite(...args);
      };
      try {
        assert.equal(
          (await runelite(fields, png, randomUUID())).statusCode,
          401,
        );
      } finally {
        store.createRuneLite = createRuneLite;
      }
      apiKey = (await clanKeys.settings()).key;
      const audit = (
        await pool.query(
          'SELECT actor_id,old_enabled,new_enabled,key_rotated,version FROM clan_api_key_audit ORDER BY version',
        )
      ).rows;
      assert.equal(audit.length, 6);
      assert.ok(audit.every((row) => row.actor_id === admin.id));
      assert.ok(
        !JSON.stringify(audit).includes(custom) &&
          !JSON.stringify(audit).includes(apiKey),
      );
      assert.equal(
        (await readdir(directory)).filter((file) => file.endsWith('.png'))
          .length,
        2,
      );
      const rename = {
        hardcoreEnabled: false,
        expectedRevision: 'settings-2',
        clanName: 'New Clan',
      };
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/admin/settings',
            headers: moderator,
            payload: rename,
          })
        ).statusCode,
        403,
      );
      const renamed = await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/settings',
        headers: owner,
        payload: rename,
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(
        (await app.inject('/api/v1/settings')).json().clanName,
        'New Clan',
      );
      assert.equal((await runelite(fields, png, key)).statusCode, 403);
      assert.equal(
        (
          await runelite(
            fields.map(([k, v]) => [k, k === 'clanName' ? 'new clan' : v]),
          )
        ).statusCode,
        201,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT old_clan_name,new_clan_name FROM site_settings_audit WHERE actor_discord_id=$1',
            [admin.id],
          )
        ).rows,
        [{ old_clan_name: 'Clan name', new_clan_name: 'New Clan' }],
      );
      for (let i = 0; i < 10; i++)
        assert.equal(await store.allowIntake('192.0.2.200'), true);
      assert.equal(await store.allowIntake('192.0.2.200'), false);
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

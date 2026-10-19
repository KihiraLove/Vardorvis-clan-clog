/** Real multipart, receipt/delivery races and explicit staff resolution. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { defaultRuneLiteRules } from '@clog/domain';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgProofStore, type RuneLiteReceipt } from './proof-store.js';
import { PgReviewStore } from './review-store.js';
import { ProofStorage } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { hashPassword } from './passwords.js';

test(
  'unmatched RuneLite intake and staff review preserve original evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'unmatched_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-unmatched-'));
    const backend = new PgStore(pool),
      store = new PgProofStore(pool);
    const review = new PgReviewStore(pool, backend),
      proofs = new ProofStorage(directory);
    const clanKeys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    const auth = {
      origin: 'https://clog.example.com',
      secret: 'a'.repeat(64),
      secure: true,
      bootstrapPassword: 'b'.repeat(64),
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
    t.after(async () => {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
      await rm(directory, { recursive: true, force: true });
    });
    const migrations = new URL(
      '../../../packages/database/migrations/',
      import.meta.url,
    );
    for (const name of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    await pool.query(`INSERT INTO items(id,name,active) VALUES(42,'Canonical item',true),(43,'Retired item',false),(44,'Unmapped canonical',true);
    INSERT INTO game_item_ids(game_item_id,item_id) VALUES(900001,42),(900002,42),(900003,43);
    INSERT INTO pages(id,name,category,sort_order) VALUES('event','Event page','bosses',0),('permanent','Permanent page','bosses',1);
    INSERT INTO page_items(page_id,item_id,slot) VALUES('event',42,0),('permanent',44,0);
    UPDATE collection_scheduling SET enabled=true,version=7;
    INSERT INTO collection_permanent_pages(page_id) VALUES('permanent');
    INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES('00000000-0000-4000-8000-000000000001','Active event',now()-interval '1 hour',now()+interval '1 hour');
    INSERT INTO collection_log_schedule_pages(schedule_id,page_id) VALUES('00000000-0000-4000-8000-000000000001','event'),('00000000-0000-4000-8000-000000000001','permanent');`);
    const rules = defaultRuneLiteRules('Clan name');
    rules.worldPolicies.members = 'allow';
    rules.worldPolicies.hardcore = 'allow';
    rules.worldPolicies.pvp = 'reject';
    await pool.query('UPDATE runelite_settings SET rules=$1', [
      JSON.stringify(rules),
    ]);
    await proofs.initialize();
    await clanKeys.ensureDefault();
    await app.ready();
    const apiKey = (await clanKeys.settings()).key;
    const admin = (await backend.accountByUsername('admin'))!;
    await backend.updateAccount(
      admin.id,
      admin.credentialVersion,
      'owner',
      await hashPassword('owner-password'),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: auth.origin },
      payload: { username: 'owner', password: 'owner-password' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const staff = {
      origin: auth.origin,
      cookie: String(login.headers['set-cookie']).split(';')[0]!,
      'x-csrf-token': login.json().csrfToken as string,
    };
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#223344' },
    })
      .png()
      .toBuffer();
    let address = 1;
    const base = (gameId = 987654, username = 'Collector') => ({
      username,
      clanName: 'Clan name',
      itemId: String(gameId),
      worldType: 'MEMBERS',
      chatMessage: 'New item added to your collection log: Unknown item',
    });
    const submit = (
      fields: Record<string, string>,
      key = randomUUID(),
      screenshot = false,
      credential = apiKey,
    ) => {
      const boundary = 'unmatched-boundary';
      return app.inject({
        method: 'POST',
        url: '/api/v1/runelite/submissions',
        remoteAddress: '192.0.2.' + address++,
        headers: {
          'content-type': 'multipart/form-data; boundary=' + boundary,
          'idempotency-key': key,
          'x-clan-api-key': credential,
        },
        payload: Buffer.concat([
          ...Object.entries(fields).map(([name, value]) =>
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            ),
          ),
          ...(screenshot
            ? [
                Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="drop.png"\r\nContent-Type: image/png\r\n\r\n`,
                ),
                png,
                Buffer.from('\r\n'),
              ]
            : []),
          Buffer.from(`--${boundary}--\r\n`),
        ]),
      });
    };
    const accepted = async (
      fields: Record<string, string>,
      key = randomUUID(),
      screenshot = false,
    ) => {
      const r = await submit(fields, key, screenshot);
      assert.equal(r.statusCode, 201, r.body);
      return r.json<RuneLiteReceipt>();
    };
    const detail = async (id: string) => {
      const response = await app.inject({
        url: '/api/v1/admin/submissions/' + id,
        headers: staff,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const change = (
      id: string,
      path: string,
      payload: Record<string, unknown>,
      method: 'POST' | 'PATCH' = 'POST',
    ) =>
      app.inject({
        method,
        url: '/api/v1/admin/submissions/' + id + path,
        headers: staff,
        payload,
      });

    let original: RuneLiteReceipt;
    const originalFields = { ...base(), itemName: ' Original unknown <name> ' },
      originalKey = randomUUID();
    await t.test(
      'unknown, inactive and missing-alias IDs create pending unmatched claims with optional PNGs',
      async () => {
        original = await accepted(originalFields, originalKey, true);
        assert.equal(original.itemId, null);
        assert.equal(original.gameItemId, 987654);
        assert.equal(original.status, 'pending');
        const row = (await detail(original.submissionId)).submission;
        assert.equal(row.rawItemText, originalFields.itemName);
        assert.equal(row.gameItemId, 987654);
        assert.equal(row.chatMessage, originalFields.chatMessage);
        assert.ok(row.screenshotPath);
        assert.equal(row.submittedAt, original.submittedAt);
        for (const gameId of [900003, 44, 987655]) {
          const receipt = await accepted({
            ...base(gameId),
            itemName: 'Unlisted item',
          });
          assert.equal(receipt.itemId, null);
          assert.equal(receipt.status, 'pending');
          assert.equal(
            (await detail(receipt.submissionId)).submission.screenshotPath,
            null,
          );
        }
        assert.equal(
          (await pool.query('SELECT count(*)::int n FROM collection_credits'))
            .rows[0].n,
          0,
        );
        assert.equal(
          (await pool.query('SELECT count(*)::int n FROM items')).rows[0].n,
          3,
        );
        assert.equal(
          (await pool.query('SELECT count(*)::int n FROM game_item_ids'))
            .rows[0].n,
          3,
        );
      },
    );
    await t.test(
      'optional names support legacy recovery/fallback and valid full multipart payloads',
      async () => {
        const recovered = await accepted(base(987656));
        assert.equal(
          (await detail(recovered.submissionId)).submission.rawItemText,
          'Unknown item',
        );
        const fallback = await accepted({
          ...base(987657),
          chatMessage: 'An unrecognized legacy message',
        });
        assert.equal(
          (await detail(fallback.submissionId)).submission.rawItemText,
          'Name not supplied — game item #987657',
        );
        for (const itemName of ['', '  ', 'bad\0name', 'a'.repeat(201)])
          assert.equal(
            (await submit({ ...base(987658), itemName })).statusCode,
            422,
          );
        const maxName = await accepted(
          { ...base(987659), itemName: 'a'.repeat(200) },
          randomUUID(),
          true,
        );
        assert.equal(
          (await detail(maxName.submissionId)).submission.rawItemText.length,
          200,
        );
        assert.equal(
          (await submit({ ...base(), itemName: 'Valid', extra: 'unexpected' }))
            .statusCode,
          413,
        );
        assert.equal(
          (await submit({ ...base(), clanName: 'Wrong clan' })).statusCode,
          403,
        );
        assert.equal(
          (await submit(base(), randomUUID(), false, 'wrong-key')).statusCode,
          401,
        );
        assert.equal(
          (await submit({ ...base(), worldType: 'BETA_WORLD' })).statusCode,
          403,
        );
        assert.equal(
          (await submit({ ...base(), chatMessage: '' })).statusCode,
          422,
        );
      },
    );
    await t.test(
      'frozen scheduling membership survives edits; HC and disabled scheduling have no event candidates',
      async () => {
        const saved = (
          await pool.query(
            'SELECT intake_scheduling e FROM submissions WHERE id=$1',
            [original.submissionId],
          )
        ).rows[0].e;
        assert.equal(saved.receivedAt, original.submittedAt);
        assert.equal(saved.revision, 'schedules-7');
        assert.equal(saved.enabled, true);
        assert.deepEqual(saved.permanentlyOpenPageIds, ['permanent']);
        assert.deepEqual(saved.eventPages, [
          {
            scheduleId: '00000000-0000-4000-8000-000000000001',
            pageId: 'event',
            itemIds: [42],
          },
        ]);
        await pool.query(
          'UPDATE collection_log_schedules SET ends_at=now() WHERE id=$1',
          ['00000000-0000-4000-8000-000000000001'],
        );
        assert.deepEqual(
          (
            await pool.query(
              'SELECT intake_scheduling e FROM submissions WHERE id=$1',
              [original.submissionId],
            )
          ).rows[0].e,
          saved,
        );
        const hc = await accepted({
          ...base(987660),
          worldType: 'HARDCORE_MAIN',
        });
        assert.equal(hc.hardcore, true);
        assert.equal(hc.status, 'pending');
        const hcEvidence = (
          await pool.query(
            'SELECT intake_scheduling e FROM submissions WHERE id=$1',
            [hc.submissionId],
          )
        ).rows[0].e;
        assert.equal(hcEvidence.enabled, false);
        assert.deepEqual(hcEvidence.eventPages, []);
        assert.deepEqual(hcEvidence.permanentlyOpenPageIds, []);
        await pool.query('UPDATE collection_scheduling SET enabled=false');
        const off = await accepted(base(987661));
        assert.equal(
          (
            await pool.query(
              'SELECT intake_scheduling e FROM submissions WHERE id=$1',
              [off.submissionId],
            )
          ).rows[0].e.enabled,
          false,
        );
      },
    );
    await t.test(
      'unrelated automatic rejection is durable even without a canonical match',
      async () => {
        const receipt = await accepted({ ...base(987662), worldType: 'PVP' });
        assert.equal(receipt.itemId, null);
        assert.equal(receipt.status, 'rejected');
        const row = await detail(receipt.submissionId);
        assert.match(row.submission.reviewReason, /PVP/u);
        assert.equal(row.audit[0].after.gameItemId, 987662);
      },
    );
    await t.test(
      'parallel observers deduplicate by normalized player/game ID/world without extending the window',
      async () => {
        const receipts = await Promise.all([
          accepted({
            ...base(987663, ' Same_Player '),
            itemName: 'First observer',
          }),
          accepted(
            { ...base(987663, 'same\u00a0player'), itemName: 'Other observer' },
            randomUUID(),
            true,
          ),
        ]);
        assert.equal(receipts[0]!.submissionId, receipts[1]!.submissionId);
        assert.equal(receipts.filter((r) => r.duplicate).length, 1);
        assert.notEqual(
          (await accepted(base(987664, 'same player'))).submissionId,
          receipts[0]!.submissionId,
        );
        assert.notEqual(
          (
            await accepted({
              ...base(987663, 'same player'),
              worldType: 'HARDCORE_MAIN',
            })
          ).submissionId,
          receipts[0]!.submissionId,
        );
        await pool.query(
          "UPDATE runelite_drop_events SET first_received_at=clock_timestamp()-interval '6 seconds' WHERE submission_id=$1",
          [receipts[0]!.submissionId],
        );
        assert.notEqual(
          (await accepted(base(987663, 'same player'))).submissionId,
          receipts[0]!.submissionId,
        );
      },
    );
    await t.test(
      'mapping creation and alias observers reuse the first unmatched receipt without silently resolving it',
      async () => {
        const first = await accepted({
          ...base(987665, 'Mapping test'),
          itemName: 'Original variant',
        });
        await pool.query(
          'INSERT INTO game_item_ids(game_item_id,item_id) VALUES(987665,42),(987666,42)',
        );
        for (const gameId of [987665, 987666, 900002]) {
          const next = await accepted(base(gameId, 'mapping_test'));
          assert.deepEqual(next, { ...first, duplicate: true });
        }
        const row = (await detail(first.submissionId)).submission;
        assert.equal(row.itemId, null);
        assert.equal(row.rawItemText, 'Original variant');
        assert.equal(row.gameItemId, 987665);
      },
    );
    await t.test(
      'notes, rejection and explicit matching work while approval requires an active match',
      async () => {
        const queue = await app.inject({
          url: '/api/v1/admin/submissions?unmatched=true',
          headers: staff,
        });
        assert.equal(queue.statusCode, 200, queue.body);
        assert.ok(
          queue
            .json()
            .submissions.every(
              (row: { itemId: number | null }) => row.itemId === null,
            ),
        );
        assert.equal(
          (
            await change(original.submissionId, '/approve', {
              expectedVersion: 1,
            })
          ).statusCode,
          422,
        );
        const note = await change(
          original.submissionId,
          '/note',
          { expectedVersion: 1, note: 'Identify this variant' },
          'PATCH',
        );
        assert.equal(note.statusCode, 200, note.body);
        assert.equal(note.json().itemId, null);
        assert.equal(
          (
            await change(
              original.submissionId,
              '',
              {
                expectedVersion: 2,
                itemId: 43,
                collectorName: 'Collector',
                collectedOn: original.collectedOn,
                hardcore: false,
                reason: '',
              },
              'PATCH',
            )
          ).statusCode,
          422,
        );
        const corrected = await change(
          original.submissionId,
          '',
          {
            expectedVersion: 2,
            itemId: 42,
            collectorName: 'Collector',
            collectedOn: original.collectedOn,
            hardcore: false,
            reason: '',
          },
          'PATCH',
        );
        assert.equal(corrected.statusCode, 200, corrected.body);
        assert.equal(corrected.json().status, 'pending');
        assert.equal(corrected.json().rawItemText, originalFields.itemName);
        assert.equal(corrected.json().gameItemId, 987654);
        assert.equal(
          (
            await change(
              original.submissionId,
              '/note',
              { expectedVersion: 2, note: 'Stale' },
              'PATCH',
            )
          ).statusCode,
          409,
        );
        const approved = await change(original.submissionId, '/approve', {
          expectedVersion: 3,
        });
        assert.equal(approved.statusCode, 200, approved.body);
        assert.equal(approved.json().status, 'approved');
        for (const audit of (await detail(original.submissionId)).audit) {
          assert.equal(audit.before.gameItemId, 987654);
          assert.equal(audit.after.gameItemId, 987654);
          assert.equal(audit.before.rawItemText, originalFields.itemName);
          assert.equal(audit.after.rawItemText, originalFields.itemName);
        }
        const unmatched = await accepted(base(987667));
        const rejected = await change(unmatched.submissionId, '/reject', {
          expectedVersion: 1,
          reason: 'Insufficient evidence',
        });
        assert.equal(rejected.statusCode, 200, rejected.body);
        assert.equal(rejected.json().itemId, null);
        assert.equal(
          (
            await app.inject(
              '/api/v1/admin/submissions/' + original.submissionId,
            )
          ).statusCode,
          401,
        );
      },
    );
    await t.test(
      'exact replay remains immutable after decisions/catalog edits and changed names conflict',
      async () => {
        await pool.query(
          'INSERT INTO game_item_ids(game_item_id,item_id) VALUES(987654,42)',
        );
        assert.deepEqual(
          await accepted(originalFields, originalKey, true),
          original,
        );
        assert.equal(
          (
            await submit(
              { ...originalFields, itemName: 'Changed' },
              originalKey,
              true,
            )
          ).statusCode,
          409,
        );
        const fields = base(900001, 'Legacy replay'),
          legacyKey = randomUUID();
        const legacy = await accepted(fields, legacyKey);
        // Emulate a pre-upgrade matched receipt/hash: no new gameItemId property.
        const { gameItemId: _newField, ...oldReceipt } = legacy;
        assert.equal(_newField, 900001);
        const legacyHash = createHash('sha256')
          .update(
            JSON.stringify([
              fields.username.trim(),
              fields.clanName.trim().toLowerCase(),
              Number(fields.itemId),
              null,
              ['MEMBERS'],
              fields.chatMessage,
            ]),
          )
          .digest('hex');
        await pool.query(
          'UPDATE runelite_submission_requests SET response=$2,payload_hash=$3 WHERE request_key=$1',
          [legacyKey, JSON.stringify(oldReceipt), legacyHash],
        );
        assert.deepEqual(await accepted(fields, legacyKey), oldReceipt);
      },
    );
    await t.test(
      'known items keep canonical receipt semantics and alias delivery deduplication',
      async () => {
        const known = await accepted(base(900001, 'Known collector'));
        assert.equal(known.itemId, 42);
        assert.equal(known.gameItemId, 900001);
        assert.equal(
          (await detail(known.submissionId)).submission.rawItemText,
          'Canonical item',
        );
        const alias = await accepted(base(900002, 'known_collector'));
        assert.deepEqual(alias, { ...known, duplicate: true });
        // The earlier approved credit prevents another automatic credit, not intake.
        assert.equal(known.status, 'pending');
        const conflict = await change(known.submissionId, '/approve', {
          expectedVersion: 1,
        });
        assert.equal(conflict.statusCode, 409);
      },
    );
  },
);

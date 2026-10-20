import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import { PgAccessControlStore } from './access-control.js';
import { hashPassword } from './passwords.js';
import type { ReviewCollectionFlags } from './review-types.js';

test(
  'separate review flags preserve credit invariants and original evidence',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'flags_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
    });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL!,
      options: '-c search_path=' + schema,
      max: 12,
    });
    const backend = new PgStore(pool),
      review = new PgReviewStore(pool, backend);
    const access = new PgAccessControlStore(pool);
    const origin = 'https://clog.example';
    const app = createApp(
      () => backend.ready(),
      () => backend.settings(),
      {
        store: backend,
        review,
        accessControl: access,
        auth: { origin, secret: 'a'.repeat(64), secure: true },
        logger: false,
      },
    );
    t.after(async () => {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    });
    const migrations = new URL(
      '../../../packages/database/migrations/',
      import.meta.url,
    );
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query(
      "INSERT INTO items(id,name) SELECT i,'Item '||i FROM generate_series(1,30) i",
    );
    const password = 'flags-test-password-only',
      hashed = await hashPassword(password);
    await backend.ensureDefaultAdmin(hashed);
    const owner = (await backend.accounts()).find((a) => a.role === 'admin')!;
    await backend.createModerator('moderator', hashed, owner.id);
    await pool.query('UPDATE staff_accounts SET must_change_password=false');
    const login = async (username: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        payload: { username, password },
      });
      assert.equal(response.statusCode, 200, response.body);
      const cookie = String(response.headers['set-cookie']).split(';')[0]!;
      const session = await app.inject({
        url: '/api/v1/auth/session',
        headers: { cookie },
      });
      return {
        origin,
        cookie,
        'x-csrf-token': session.json().csrfToken as string,
      };
    };
    const headers = await login('admin'),
      moderator = await login('moderator');
    const regular: ReviewCollectionFlags = {
        hardcore: false,
        collectionType: 'regular',
      },
      event: ReviewCollectionFlags = {
        hardcore: false,
        collectionType: 'event',
      },
      hardcore: ReviewCollectionFlags = {
        hardcore: true,
        collectionType: 'regular',
      };
    const create = (itemId: number, approve = false) =>
      review.createManual(
        {
          itemId,
          collectorName: 'Collector',
          collectedOn: '2026-01-01',
          hardcore: false,
          approve,
        },
        owner.id,
        'Owner',
        randomUUID(),
      );
    const write = (
      id: string,
      action: string,
      payload: object,
      actor = headers,
    ) =>
      app.inject({
        method: action === 'flags' ? 'PATCH' : 'POST',
        url: '/api/v1/admin/submissions/' + id + '/' + action,
        headers: actor,
        payload,
      });
    const saved = async (id: string) => (await review.detail(id))!.submission;
    const original = async (id: string) =>
      (
        await pool.query(
          'SELECT raw_item_text,game_item_id,submitted_clan_name,submitted_world_types,chat_message,intake_scheduling,intake_payload_hash,intake_receipt,submitted_at,review_note,collector_name,collected_on FROM submissions WHERE id=$1',
          [id],
        )
      ).rows[0];
    const imported = async (itemId: number, unmatched = false) => {
      const row = await create(itemId);
      await pool.query(
        `UPDATE submissions SET source='runelite',game_item_id=900001,submitted_clan_name='Original clan',submitted_world_types=ARRAY['MEMBERS'],chat_message='Original item proof',intake_payload_hash=$2,intake_receipt='{"saved":"original receipt"}'::jsonb,intake_scheduling=$3,collection_reason='legacy',item_id=CASE WHEN $4 THEN NULL ELSE item_id END,collection_type=CASE WHEN $4 THEN NULL ELSE collection_type END WHERE id=$1`,
        [
          row.id,
          'b'.repeat(64),
          JSON.stringify({
            receivedAt: '2026-01-01T00:00:00Z',
            enabled: true,
            revision: 'original',
            permanentlyOpenPageIds: [],
            eventPages: [
              {
                scheduleId: randomUUID(),
                pageId: 'old-page',
                itemIds: [itemId],
              },
            ],
          }),
          unmatched,
        ],
      );
      return saved(row.id);
    };

    await t.test(
      'pending decisions save flags in the same revision/audit and preserve untouched classification',
      async () => {
        for (const [n, flags] of [event, hardcore, undefined].entries()) {
          const row = await create(n + 1),
            before = await original(row.id);
          const response = await write(row.id, 'approve', {
            expectedVersion: row.version,
            ...(flags ? { flags } : {}),
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().version, 2);
          assert.equal(
            response.json().collectionType,
            flags?.collectionType ?? 'regular',
          );
          assert.equal(response.json().hardcore, flags?.hardcore ?? false);
          assert.equal(
            response.json().collectionReason,
            flags ? 'staff_correction' : 'manual',
          );
          assert.deepEqual(await original(row.id), before);
          const audit = (await review.detail(row.id))!.audit;
          assert.equal(audit.length, 2);
          assert.equal(audit[0]!.action, 'approve');
          assert.equal(audit[0]!.before.status, 'pending');
          assert.equal(
            audit[0]!.after.collectionType,
            flags?.collectionType ?? 'regular',
          );
          assert.equal(
            (
              await write(row.id, 'approve', {
                expectedVersion: 1,
                flags: regular,
              })
            ).statusCode,
            409,
          );
        }
        const unknown = await imported(4, true),
          before = await original(unknown.id);
        const rejected = await write(unknown.id, 'reject', {
          expectedVersion: 1,
          reason: 'Invalid evidence',
          flags: hardcore,
        });
        assert.equal(rejected.statusCode, 200, rejected.body);
        assert.equal(rejected.json().hardcore, true);
        assert.equal(rejected.json().itemId, null);
        assert.deepEqual(await original(unknown.id), before);
        assert.equal(
          (await backend.collections()).some(
            (c) => c.submissionId === unknown.id,
          ),
          false,
        );
      },
    );
    await t.test(
      'approved flag saves preserve unrelated fields, invalidate public projections and enforce reasons/status',
      async () => {
        const row = await create(5, true);
        await review.mutate(
          row.id,
          1,
          { note: 'Keep this note' },
          owner.id,
          'Owner',
        );
        const before = await original(row.id),
          revision = await pool.query(
            "SELECT version FROM projection_state WHERE resource='collections'",
          );
        assert.equal(
          (
            await write(row.id, 'flags', {
              expectedVersion: 2,
              flags: event,
              reason: '',
            })
          ).statusCode,
          422,
        );
        const response = await write(row.id, 'flags', {
          expectedVersion: 2,
          flags: event,
          reason: 'Event proof verified',
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(await original(row.id), before);
        assert.equal(response.json().version, 3);
        assert.equal(response.json().reviewNote, 'Keep this note');
        const credits = await backend.collections();
        assert.equal(
          credits.find((c) => c.submissionId === row.id)!.collectionType,
          'event',
        );
        assert.notEqual(
          (
            await pool.query(
              "SELECT version FROM projection_state WHERE resource='collections'",
            )
          ).rows[0].version,
          revision.rows[0].version,
        );
        const audit = (await review.detail(row.id))!.audit[0]!;
        assert.equal(audit.action, 'edit');
        assert.equal(audit.reason, 'Event proof verified');
        assert.equal(audit.before.collectionType, 'regular');
        assert.equal(audit.after.collectionType, 'event');
        assert.equal(
          (
            await write(row.id, 'revoke', {
              expectedVersion: 3,
              reason: 'Revoke',
              flags: regular,
            })
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await write(row.id, 'revoke', {
              expectedVersion: 3,
              reason: 'Revoke',
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await write(row.id, 'flags', {
              expectedVersion: 4,
              flags: regular,
              reason: 'Change',
            })
          ).statusCode,
          409,
        );
        const pending = await create(6);
        assert.equal(
          (
            await write(pending.id, 'flags', {
              expectedVersion: 1,
              flags: regular,
              reason: 'Change',
            })
          ).statusCode,
          409,
        );
      },
    );
    await t.test(
      'invalid flags and credit conflicts roll back decisions, approved moves and audit',
      async () => {
        const row = await create(7);
        for (const flags of [
          { hardcore: true, collectionType: 'event' },
          { hardcore: 'true', collectionType: 'regular' },
          { hardcore: false },
          { ...event, useIntakeTiming: true },
          { hardcore: false, useIntakeTiming: true },
        ]) {
          const response = await write(row.id, 'approve', {
            expectedVersion: 1,
            flags,
          });
          assert.ok([400, 422].includes(response.statusCode), response.body);
          assert.equal((await saved(row.id)).version, 1);
          assert.equal((await review.detail(row.id))!.audit.length, 1);
        }
        const occupied = await create(8, true),
          pending = await create(8);
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=true',
        );
        assert.equal(
          (
            await write(pending.id, 'approve', {
              expectedVersion: 1,
              flags: regular,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await write(pending.id, 'approve', {
              expectedVersion: 1,
              flags: hardcore,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await write(occupied.id, 'flags', {
              expectedVersion: 1,
              flags: hardcore,
              reason: 'Move world',
            })
          ).statusCode,
          409,
        );
        assert.equal((await saved(occupied.id)).hardcore, false);
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=false',
        );
        const competitors = await Promise.all([create(9), create(9)]);
        const outcomes = await Promise.all(
          competitors.map((r) =>
            write(r.id, 'approve', { expectedVersion: 1, flags: event }),
          ),
        );
        assert.deepEqual(outcomes.map((r) => r.statusCode).sort(), [200, 409]);
        const regularCredit = await create(9, true);
        assert.equal(
          (
            await write(regularCredit.id, 'flags', {
              expectedVersion: 1,
              flags: event,
              reason: 'Move type',
            })
          ).statusCode,
          409,
        );
        const concurrent = await create(10);
        const decisions = await Promise.all(
          [event, hardcore].map((flags) =>
            write(concurrent.id, 'approve', { expectedVersion: 1, flags }),
          ),
        );
        assert.deepEqual(decisions.map((r) => r.statusCode).sort(), [200, 409]);
        assert.equal((await review.detail(concurrent.id))!.audit.length, 2);
        await pool.query(
          "CREATE FUNCTION fail_flags_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER fail_flags_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_flags_audit()",
        );
        try {
          const before = await saved(regularCredit.id);
          assert.equal(
            (
              await write(regularCredit.id, 'flags', {
                expectedVersion: 1,
                flags: hardcore,
                reason: 'Rollback',
              })
            ).statusCode,
            503,
          );
          assert.deepEqual(await saved(regularCredit.id), before);
          const undecided =
            competitors[outcomes.findIndex((r) => r.statusCode === 409)]!;
          assert.equal(
            (
              await write(undecided.id, 'approve', {
                expectedVersion: 1,
                flags: hardcore,
              })
            ).statusCode,
            503,
          );
          assert.equal((await saved(undecided.id)).status, 'pending');
        } finally {
          await pool.query('DROP FUNCTION fail_flags_audit() CASCADE');
        }
      },
    );
    await t.test(
      'restoring frozen intake timing works after matching and preserves source evidence',
      async () => {
        const row = await imported(11),
          before = await original(row.id);
        const response = await write(row.id, 'approve', {
          expectedVersion: 1,
          flags: { hardcore: false, useIntakeTiming: true },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().collectionType, 'event');
        assert.equal(response.json().collectionReason, 'timed_event');
        assert.deepEqual(await original(row.id), before);
        const unknown = await imported(12, true);
        const matched = await review.mutate(
          unknown.id,
          1,
          {
            itemId: 12,
            collectorName: unknown.collectorName,
            collectedOn: unknown.collectedOn,
            hardcore: false,
            collectionType: 'regular',
            reason: '',
          },
          owner.id,
          'Owner',
        );
        assert.equal(matched.collectionType, 'regular');
        const approved = await write(unknown.id, 'approve', {
          expectedVersion: 2,
          flags: { hardcore: false, useIntakeTiming: true },
        });
        assert.equal(approved.statusCode, 200, approved.body);
        assert.equal(approved.json().collectionType, 'event');
      },
    );
    await t.test(
      'CSRF and moderator page access protect decisions and the separate flags endpoint',
      async () => {
        const row = await create(13, true),
          payload = { expectedVersion: 1, flags: event, reason: 'Verified' };
        assert.equal(
          (
            await app.inject({
              method: 'PATCH',
              url: '/api/v1/admin/submissions/' + row.id + '/flags',
              payload,
            })
          ).statusCode,
          401,
        );
        assert.equal(
          (
            await write(row.id, 'flags', payload, {
              ...headers,
              'x-csrf-token': 'invalid',
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await write(row.id, 'flags', payload, moderator)).statusCode,
          200,
        );
        await access.update([], (await access.settings()).revision, owner.id);
        assert.equal(
          (
            await write(
              row.id,
              'flags',
              { ...payload, expectedVersion: 2, flags: regular },
              moderator,
            )
          ).statusCode,
          403,
        );
        const pending = await create(14);
        assert.equal(
          (
            await write(
              pending.id,
              'approve',
              { expectedVersion: 1, flags: event },
              moderator,
            )
          ).statusCode,
          403,
        );
        assert.equal((await saved(pending.id)).version, 1);
      },
    );
  },
);

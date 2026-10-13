/** Database-backed REVIEW-01 / HC-01 integration, with no live Discord credentials. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './passwords.js';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import type { AuthConfig } from './config.js';

const adminId = '00000000-0000-4000-8000-000000000001';
const password = 'integration-test-password-only';
const auth: AuthConfig = {
  origin: 'https://clog.example.com',
  secret: 'a'.repeat(64),
  secure: true,
};
test(
  'review APIs atomically preserve one credit per world, audits, CSRF and conflict safety',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'review_test_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      max: 12,
      statement_timeout: 8000,
    });
    let app: ReturnType<typeof createApp> | undefined;
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
        "INSERT INTO items(id,name,icon_path) VALUES (42,'Vardorvis item','/items/42.png'),(43,'Shared item','/items/43.png')",
      );
      const accountStore = new PgStore(pool);
      await accountStore.ensureDefaultAdmin(await hashPassword(password));
      await pool.query('UPDATE staff_accounts SET must_change_password=false');
      await pool.query(
        "INSERT INTO pages(id,name,category,sort_order) VALUES ('v','Vardorvis','bosses',0),('x','Other','other',1)",
      );
      await pool.query(
        "INSERT INTO page_items(page_id,item_id,slot) VALUES ('v',42,0),('v',43,1),('x',42,0)",
      );
      const backend = new PgStore(pool),
        review = new PgReviewStore(pool, backend);
      app = createApp(
        () => backend.ready(),
        () => backend.settings(),
        {
          store: backend,
          review,
          auth,
          logger: false,
        },
      );
      const create = async (
        itemId: number | null,
        hardcore = false,
        proof = 'https://m.imgur.com/acceptable',
      ) => {
        const id = randomUUID();
        await pool.query(
          'INSERT INTO submissions(id,discord_interaction_id,discord_user_id,discord_guild_id,' +
            'raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,hardcore)' +
            " VALUES($1,$2,'user','guild','Vardorvis item',$3,'Collector','2026-10-05','submission_default',$4,$5)",
          [id, randomUUID(), itemId, proof, hardcore],
        );
        return id;
      };
      const one = await create(null);
      const second = await create(42),
        hardcore = await create(42, true);
      const unmatched = await review.queue('pending', true, 20);
      assert.deepEqual(
        unmatched.submissions.map((s) => s.id),
        [one],
      );
      assert.equal(unmatched.submissions[0]?.dateSource, 'submission');
      const all = await review.queue('pending', false, 1);
      assert.ok(all.nextCursor);
      const next = await review.queue('pending', false, 1, all.nextCursor!);
      assert.equal(next.submissions.length, 1);
      const matched = await review.mutate(
        one,
        1,
        {
          itemId: 42,
          collectorName: 'Collector',
          collectedOn: '2026-10-05',
          hardcore: false,
          reason: 'Manual match',
        },
        adminId,
        'Reviewer',
      );
      assert.equal(matched.version, 2);
      assert.equal(matched.status, 'pending');
      await assert.rejects(review.queue('pending', false, 1, all.nextCursor!), {
        status: 409,
      });
      const credited = await review.mutate(
        one,
        2,
        { expectedVersion: 2, action: 'approve' },
        adminId,
        'Reviewer',
      );
      assert.equal(credited.status, 'approved');
      assert.equal(credited.version, 3);
      assert.equal((await backend.collections()).length, 1);
      await assert.rejects(
        review.mutate(
          second,
          1,
          { expectedVersion: 1, action: 'approve' },
          adminId,
          'Reviewer',
        ),
        {
          status: 409,
          message:
            /An approved credit already exists for this item and world mode/,
        },
      );
      assert.equal((await review.detail(second))?.submission.status, 'pending');
      const hc = await review.mutate(
        hardcore,
        1,
        { expectedVersion: 1, action: 'approve' },
        adminId,
        'Reviewer',
      );
      assert.equal(hc.hardcore, true);
      const credits = await backend.collections();
      assert.equal(credits.length, 2);
      assert.deepEqual(
        credits.map((c) => c.hardcore),
        [false, true],
      );
      await assert.rejects(
        review.mutate(
          one,
          3,
          {
            itemId: 42,
            collectorName: 'Collector',
            collectedOn: '2026-10-05',
            hardcore: true,
            reason: 'Move to occupied hardcore mode',
          },
          adminId,
          'Reviewer',
        ),
        { status: 409 },
      );
      assert.equal((await review.detail(one))?.submission.hardcore, false);
      assert.deepEqual(
        (await backend.collections()).map((c) => c.hardcore),
        [false, true],
      );
      await assert.rejects(
        review.mutate(
          one,
          2,
          { expectedVersion: 2, action: 'revoke', reason: 'Correction' },
          adminId,
          'Reviewer',
        ),
        { status: 409 },
      );
      const revoked = await review.mutate(
        one,
        3,
        { expectedVersion: 3, action: 'revoke', reason: 'Invalid proof' },
        adminId,
        'Reviewer',
      );
      assert.equal(revoked.status, 'revoked');
      assert.equal((await backend.collections()).length, 1);
      assert.equal((await backend.collections())[0]?.hardcore, true);
      const detail = await review.detail(one);
      assert.equal(detail?.audit.length, 3);
      assert.equal(detail?.audit[0]?.reason, 'Invalid proof');
      assert.equal(detail?.audit[0]?.actorName, 'Reviewer');
      assert.equal(detail?.audit[0]?.before.status, 'approved');
      assert.equal(detail?.audit[0]?.after.status, 'revoked');
      const invalid = await create(43, false, 'https://example.com/proof');
      await assert.rejects(
        review.mutate(
          invalid,
          1,
          { expectedVersion: 1, action: 'approve' },
          adminId,
          'Reviewer',
        ),
        { status: 422 },
      );
      const p1 = await create(43),
        p2 = await create(43);
      const races = await Promise.allSettled(
        [p1, p2].map((id) =>
          review.mutate(
            id,
            1,
            { expectedVersion: 1, action: 'approve' },
            adminId,
            'Reviewer',
          ),
        ),
      );
      assert.equal(races.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(
        races.filter((x) => x.status === 'rejected' && x.reason.status === 409)
          .length,
        1,
      );
      assert.equal((await backend.collections()).length, 2);
      const catalog = (await review.adminCatalog()) as {
        items: unknown[];
        pages: unknown[];
      };
      assert.equal(catalog.items.length, 2);
      assert.equal(catalog.pages.length, 2);
      // Authenticated browser endpoints, separate from bot ***
      assert.equal(
        (await app.inject('/api/v1/admin/submissions')).statusCode,
        401,
      );
      assert.equal((await app.inject('/api/v1/admin/catalog')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/submissions/' + one + '/revoke',
            method: 'POST',
            headers: { authorization: 'Bearer ' + 'a'.repeat(64) },
            payload: { expectedVersion: 4, reason: 'Unauthorized' },
          })
        ).statusCode,
        401,
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: auth.origin },
        payload: { username: 'admin', password },
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const session = (
        await app.inject({ url: '/api/v1/auth/session', headers: { cookie } })
      ).json();
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/catalog',
            headers: { cookie },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/submissions?status=reviewed',
            headers: { cookie },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/submissions/' + one,
            headers: { cookie },
          })
        ).statusCode,
        200,
      );
      const denied = await app.inject({
        url: '/api/v1/admin/submissions/' + second + '/reject',
        method: 'POST',
        headers: { cookie },
        payload: { expectedVersion: 1, reason: 'Bad evidence' },
      });
      assert.equal(denied.statusCode, 403);
      const accepted = await app.inject({
        url: '/api/v1/admin/submissions/' + second + '/reject',
        method: 'POST',
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': randomUUID(),
        },
        payload: { expectedVersion: 1, reason: 'Bad evidence' },
      });
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().status, 'rejected');
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM audit_events WHERE submission_id=$1',
            [second],
          )
        ).rows[0].n,
        1,
      );
      // Manual claims are first-class submissions with no Discord identifiers.
      const manual = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/submissions',
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': randomUUID(),
        },
        payload: {
          itemId: 42,
          collectorName: 'Manual collector',
          collectedOn: '2026-10-04',
          hardcore: false,
          approve: true,
          reason: 'Added from admin panel',
        },
      });
      assert.equal(manual.statusCode, 201);
      assert.equal(manual.json().source, 'manual');
      assert.equal(manual.json().status, 'approved');
      assert.equal(manual.json().proofUrl, '');
      assert.equal((await backend.collections()).length, 3);
      const manualId = manual.json().id as string;
      const provenance = (
        await pool.query(
          'SELECT source,discord_user_id,discord_interaction_id FROM submissions WHERE id=$1',
          [manualId],
        )
      ).rows[0]!;
      assert.deepEqual(provenance, {
        source: 'manual',
        discord_user_id: null,
        discord_interaction_id: null,
      });
      const manualAudit = await review.detail(manualId);
      assert.equal(manualAudit?.audit[0]?.action, 'create');
      assert.equal(manualAudit?.audit[0]?.actorName, 'admin');
      const collision = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/submissions',
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': randomUUID(),
        },
        payload: {
          itemId: 42,
          collectorName: 'Duplicate',
          collectedOn: '2026-10-04',
          hardcore: false,
          approve: true,
        },
      });
      assert.equal(collision.statusCode, 409);
      assert.match(
        collision.json().error,
        /already has an approved ordinary collection log entry/,
      );
      const pendingManual = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/submissions',
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
          'idempotency-key': randomUUID(),
        },
        payload: {
          itemId: 43,
          collectorName: 'Pending manual',
          collectedOn: '2026-10-03',
          hardcore: false,
          approve: false,
        },
      });
      assert.equal(pendingManual.statusCode, 201);
      assert.equal(pendingManual.json().status, 'pending');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/submissions',
            payload: {
              itemId: 43,
              collectorName: 'Anonymous',
              collectedOn: '2026-10-03',
              hardcore: false,
              approve: false,
            },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/submissions',
            headers: { cookie },
            payload: {
              itemId: 43,
              collectorName: 'No CSRF',
              collectedOn: '2026-10-03',
              hardcore: false,
              approve: false,
            },
          })
        ).statusCode,
        403,
      );
      // An audit-write failure cannot leave a new approved credit without history.
      const rollback = await create(43, true);
      await pool.query(
        "ALTER TABLE audit_events ADD CONSTRAINT block_actor CHECK (actor_name <> 'Blocked')",
      );
      await assert.rejects(
        review.mutate(
          rollback,
          1,
          { expectedVersion: 1, action: 'approve' },
          adminId,
          'Blocked',
        ),
      );
      assert.equal(
        (await review.detail(rollback))?.submission.status,
        'pending',
      );
      assert.equal((await backend.collections()).length, 3);
      // Lost replies and concurrent retries share a durable immutable receipt.
      for (const approve of [false, true]) {
        const fields = {
          itemId: 43,
          collectorName: 'Retry tester',
          collectedOn: '2026-10-03',
          hardcore: true,
          approve,
        };
        const key = randomUUID();
        const [first, replay] = await Promise.all([
          review.createManual(fields, adminId, 'Reviewer', key),
          new PgReviewStore(pool, backend).createManual(
            fields,
            adminId,
            'Reviewer',
            key,
          ),
        ]);
        assert.deepEqual(replay, first);
        assert.equal((await review.detail(first.id))?.audit.length, 1);
        await review.mutate(
          first.id,
          1,
          {
            expectedVersion: 1,
            action: approve ? 'revoke' : 'reject',
            reason: 'Later review',
          },
          adminId,
          'Reviewer',
        );
        assert.deepEqual(
          await new PgReviewStore(pool, backend).createManual(
            fields,
            adminId,
            'Reviewer',
            key,
          ),
          first,
        );
        await assert.rejects(
          review.createManual(
            { ...fields, collectorName: 'Changed' },
            adminId,
            'Reviewer',
            key,
          ),
          { status: 409 },
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM manual_submission_requests WHERE actor_id=$1 AND request_key=$2',
              [adminId, key],
            )
          ).rows[0].n,
          1,
        );
        // The same key used by another actor is a distinct operation.
        const other = await review.createManual(
          fields,
          'other-admin',
          'Other',
          key,
        );
        assert.notEqual(other.id, first.id);
        if (approve)
          await review.mutate(
            other.id,
            1,
            { expectedVersion: 1, action: 'revoke', reason: 'Test cleanup' },
            'other-admin',
            'Other',
          );
      }
      const retryFields = {
        itemId: 43,
        collectorName: 'Rollback tester',
        collectedOn: '2026-10-03',
        hardcore: false,
        approve: false,
      };
      const retryKey = randomUUID();
      await assert.rejects(
        review.createManual(retryFields, adminId, 'Blocked', retryKey),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM manual_submission_requests WHERE request_key=$1',
            [retryKey],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await review.createManual(retryFields, adminId, 'Reviewer', retryKey))
          .status,
        'pending',
      );
      // A saved note is not the review_reason used for decisions. It is
      // versioned/audited independently, even for an unmatched pending claim.
      const noteOnly = await create(null);
      const publicCredits = await backend.collections();
      const created = await review.mutate(
        noteOnly,
        1,
        { note: '  Check duplicate proof  ' },
        adminId,
        'Reviewer',
      );
      assert.equal(created.reviewNote, 'Check duplicate proof');
      assert.equal(created.reviewReason, null);
      assert.equal(created.version, 2);
      assert.equal(created.itemId, null);
      assert.equal(created.status, 'pending');
      const noteDetail = await review.detail(noteOnly);
      assert.equal(noteDetail?.audit.length, 1);
      assert.equal(noteDetail?.audit[0]?.reason, null);
      assert.equal(noteDetail?.audit[0]?.before.reviewNote, '');
      assert.equal(
        noteDetail?.audit[0]?.after.reviewNote,
        'Check duplicate proof',
      );
      assert.deepEqual(await backend.collections(), publicCredits);
      await assert.rejects(
        review.mutate(
          noteOnly,
          2,
          { note: 'Check duplicate proof' },
          adminId,
          'Reviewer',
        ),
        { status: 422 },
      );
      await assert.rejects(
        review.mutate(noteOnly, 1, { note: 'Stale' }, adminId, 'Reviewer'),
        { status: 409 },
      );
      await assert.rejects(
        review.mutate(
          noteOnly,
          2,
          { note: 'x'.repeat(1001) },
          adminId,
          'Reviewer',
        ),
        { status: 422 },
      );
      const cleared = await review.mutate(
        noteOnly,
        2,
        { note: '' },
        adminId,
        'Reviewer',
      );
      assert.equal(cleared.reviewNote, '');
      assert.equal((await review.detail(noteOnly))?.audit.length, 2);
      assert.deepEqual(await backend.collections(), publicCredits);

      // Approved notes cannot touch the existing credit or decision reason.
      const approvalBefore = (await review.detail(manualId))!.submission;
      assert.equal(approvalBefore.status, 'approved');
      const approvedNote = await review.mutate(
        manualId,
        approvalBefore.version,
        { note: 'Approved evidence reviewed' },
        adminId,
        'Reviewer',
      );
      assert.equal(approvedNote.reviewNote, 'Approved evidence reviewed');
      assert.equal(approvedNote.reviewReason, approvalBefore.reviewReason);
      assert.equal(approvedNote.status, approvalBefore.status);
      assert.equal(approvedNote.itemId, approvalBefore.itemId);
      assert.deepEqual(await backend.collections(), publicCredits);
      await assert.rejects(
        review.mutate(
          second,
          2,
          { note: 'Rejected cannot edit' },
          adminId,
          'Reviewer',
        ),
        { status: 409 },
      );

      // The HTTP route uses the existing administrator cookie and CSRF
      // contract, not an unguarded generic note updater.
      const notePath = '/api/v1/admin/submissions/' + noteOnly + '/note';
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: notePath,
            payload: { expectedVersion: 3, note: 'Unauthorized' },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: notePath,
            headers: { cookie },
            payload: { expectedVersion: 3, note: 'Missing CSRF' },
          })
        ).statusCode,
        403,
      );
      const noteHttp = await app.inject({
        method: 'PATCH',
        url: notePath,
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
        },
        payload: { expectedVersion: 3, note: 'Saved through HTTP' },
      });
      assert.equal(noteHttp.statusCode, 200);
      assert.equal(noteHttp.json().reviewNote, 'Saved through HTTP');
      assert.equal(noteHttp.json().version, 4);
      const staleHttp = await app.inject({
        method: 'PATCH',
        url: notePath,
        headers: {
          cookie,
          origin: auth.origin,
          'x-csrf-token': session.csrfToken,
        },
        payload: { expectedVersion: 3, note: 'Old version' },
      });
      assert.equal(staleHttp.statusCode, 409);
      assert.deepEqual(await backend.collections(), publicCredits);
      for (const key of [undefined, 'invalid']) {
        const response: { statusCode: number } = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/submissions',
          headers: {
            cookie,
            origin: auth.origin,
            'x-csrf-token': session.csrfToken,
            ...(key ? { 'idempotency-key': key } : {}),
          },
          payload: retryFields,
        });
        assert.equal(response.statusCode, 400);
      }
    } finally {
      await app?.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);

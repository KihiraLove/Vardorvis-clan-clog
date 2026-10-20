/** Genuine later obtains keep credit without replacing the first Event collector. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { defaultRuneLiteRules } from '@clog/domain';
import { PgStore } from './store.js';
import { PgProofStore } from './proof-store.js';
import { PgReviewStore } from './review-store.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { claimHash } from './intake.js';
import { screenshotRecord } from './tests/screenshot.js';

test(
  'occupied Event credits fall back to Regular only with regular filtering off',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = 'event_fallback_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-event-fallback-'));
    t.after(async () => {
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
    const backend = new PgStore(pool);
    const proof = new PgProofStore(pool);
    const review = new PgReviewStore(pool, backend);
    const keys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    await keys.ensureDefault();
    const key = (await keys.settings()).key;
    await pool.query(`
      INSERT INTO items(id,name) SELECT i,'Item '||i FROM generate_series(1,10) i;
      INSERT INTO game_item_ids(game_item_id,item_id) SELECT 900000+id,id FROM items;
      INSERT INTO game_item_ids(game_item_id,item_id) VALUES(990001,1);
      INSERT INTO pages(id,name,category,sort_order) VALUES('timed','Timed','bosses',0),('shared','Shared','bosses',1);
      INSERT INTO page_items(page_id,item_id,slot) SELECT 'timed',id,id FROM items;
      INSERT INTO page_items(page_id,item_id,slot) VALUES('shared',1,0);
      UPDATE collection_scheduling SET enabled=true;
      INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES('00000000-0000-4000-8000-000000000001','Open event',now()-interval '1 hour',now()+interval '1 hour');
      INSERT INTO collection_log_schedule_pages(schedule_id,page_id) VALUES('00000000-0000-4000-8000-000000000001','timed');
    `);
    const rules = defaultRuneLiteRules('Clan name');
    rules.worldPolicies.members = 'allow';
    rules.worldPolicies.hardcore = 'allow';
    await pool.query('UPDATE runelite_settings SET rules=$1', [
      JSON.stringify(rules),
    ]);
    const fields = (itemId: number, username: string = randomUUID()) => ({
      username,
      clanName: 'Clan name',
      itemId: 900000 + itemId,
      itemName: 'Item ' + itemId,
      worldTypes: ['MEMBERS'],
      chatMessage: username + ' received Item ' + itemId,
    });
    const rune = (itemId: number) =>
      proof.createRuneLite(fields(itemId), undefined, randomUUID(), key);
    const manual = (itemId: number, approve = true) =>
      review.createManual(
        {
          itemId,
          collectorName: 'Manual collector',
          collectedOn: '2026-10-18',
          hardcore: false,
          collectionType: 'event',
          approve,
        },
        'owner',
        'Owner',
        randomUUID(),
      );
    const approve = (id: string, version = 1) =>
      review.mutate(
        id,
        version,
        { action: 'approve', expectedVersion: version },
        'owner',
        'Owner',
      );
    const revoke = (id: string, version: number) =>
      review.mutate(
        id,
        version,
        { action: 'revoke', expectedVersion: version, reason: 'Invalid proof' },
        'owner',
        'Owner',
      );
    const filter = (enabled: boolean) =>
      pool.query('UPDATE submission_filter_settings SET filter_collected=$1', [
        enabled,
      ]);
    let interaction = 200000000000000000n;
    const discordInput = (itemId: number) => ({
      interactionId: String(interaction++),
      guildId: '123456789012345678',
      actorDiscordId: '234567890123456789',
      rawItemText: 'Item ' + itemId,
      itemId,
      collectorName: 'Discord collector',
      image: screenshotRecord(),
      hardcore: false,
    });
    const detail = async (id: string) => (await review.detail(id))!;

    await t.test(
      'open-schedule intake, aliases, genuine repeats and durable delivery receipts',
      async () => {
        const first = await rune(1);
        assert.equal(first.receipt.collectionType, 'event');
        const original = await detail(first.receipt.submissionId);
        const laterFields = fields(1, 'Later collector');
        const requestKey = randomUUID();
        const image = screenshotRecord();
        const later = await proof.createRuneLite(
          laterFields,
          image,
          requestKey,
          key,
        );
        assert.equal(later.receipt.collectionType, 'regular');
        assert.equal(later.receipt.status, 'approved');
        const saved = await detail(later.receipt.submissionId);
        assert.equal(
          saved.submission.collectionReason,
          'event_credit_already_obtained',
        );
        assert.equal(saved.submission.chatMessage, laterFields.chatMessage);
        assert.equal(
          saved.submission.screenshotPath,
          '/api/v1/admin/submission-images/' + image.id + '.webp',
        );
        assert.equal(saved.audit[0]!.after.collectionType, 'regular');
        const evidence = await pool.query(
          'SELECT intake_scheduling FROM submissions WHERE id=$1',
          [later.receipt.submissionId],
        );
        assert.equal(
          evidence.rows[0].intake_scheduling.eventPages[0].scheduleId,
          '00000000-0000-4000-8000-000000000001',
        );
        const alias = await proof.createRuneLite(
          { ...laterFields, itemId: 990001 },
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(alias.receipt.duplicate, true);
        assert.equal(alias.receipt.submissionId, later.receipt.submissionId);
        await pool.query(
          "UPDATE runelite_drop_events SET first_received_at=clock_timestamp()-interval '6 seconds' WHERE submission_id=$1",
          [later.receipt.submissionId],
        );
        const repeat = await proof.createRuneLite(
          laterFields,
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(repeat.receipt.status, 'approved');
        assert.equal(repeat.receipt.collectionType, 'regular');
        assert.notEqual(
          repeat.receipt.submissionId,
          later.receipt.submissionId,
        );
        const input = discordInput(1);
        const bot = await backend.submitClaim(input, claimHash(input));
        assert.equal(bot.receipt.collectionType, 'regular');
        assert.equal(bot.receipt.creditOccupied, false);
        assert.equal(
          (await approve(bot.receipt.submissionId)).collectionType,
          'regular',
        );
        await filter(true);
        assert.deepEqual(
          (await proof.createRuneLite(laterFields, image, requestKey, key))
            .receipt,
          later.receipt,
        );
        assert.deepEqual(
          (await backend.submitClaim(input, claimHash(input))).receipt,
          bot.receipt,
        );
        const credits = (await backend.collections()).filter(
          (c) => c.itemId === 1,
        );
        assert.equal(credits.length, 4);
        assert.equal(
          credits.filter((c) => c.collectionType === 'event').length,
          1,
        );
        assert.deepEqual(
          (await detail(first.receipt.submissionId)).submission,
          original.submission,
        );
        await filter(false);
      },
    );

    await t.test(
      'normal review and matching retain fallback after schedule closure and Event revocation',
      async () => {
        const event = await manual(2);
        rules.worldPolicies.members = 'review';
        await pool.query('UPDATE runelite_settings SET rules=$1', [
          JSON.stringify(rules),
        ]);
        const pending = await rune(2);
        assert.equal(pending.receipt.status, 'pending');
        assert.equal(pending.receipt.collectionType, 'regular');
        const unknownFields = { ...fields(2), itemId: 999999 };
        const requestKey = randomUUID();
        const unknown = await proof.createRuneLite(
          unknownFields,
          undefined,
          requestKey,
          key,
        );
        assert.equal(unknown.receipt.itemId, null);
        assert.equal(unknown.receipt.collectionType, null);
        await pool.query(
          "UPDATE collection_log_schedules SET ends_at=now(); DELETE FROM page_items WHERE page_id='timed' AND item_id=2",
        );
        const correction = {
          itemId: 2,
          collectorName: 'Matched collector',
          collectedOn: '2026-10-18',
          hardcore: false,
          reason: 'Match original item',
        };
        const resolved = await review.mutate(
          unknown.receipt.submissionId,
          1,
          correction,
          'owner',
          'Owner',
        );
        assert.equal(
          resolved.collectionReason,
          'event_credit_already_obtained',
        );
        assert.equal(resolved.collectionType, 'regular');
        assert.equal(resolved.status, 'pending');
        const approved = await approve(resolved.id, resolved.version);
        assert.equal(approved.collectionType, 'regular');
        await revoke(event.id, event.version);
        const edited = await review.mutate(
          approved.id,
          approved.version,
          { ...correction, collectorName: 'Corrected collector' },
          'owner',
          'Owner',
        );
        assert.equal(edited.collectionReason, 'event_credit_already_obtained');
        assert.equal(edited.collectionType, 'regular');
        const explicit = await review.mutate(
          edited.id,
          edited.version,
          {
            ...correction,
            collectorName: edited.collectorName,
            useIntakeTiming: true,
          },
          'owner',
          'Owner',
        );
        assert.equal(explicit.collectionType, 'event');
        assert.equal(explicit.collectionReason, 'timed_event');
        assert.deepEqual(
          (
            await proof.createRuneLite(
              unknownFields,
              undefined,
              requestKey,
              key,
            )
          ).receipt,
          unknown.receipt,
        );
        assert.equal(
          (await approve(pending.receipt.submissionId)).collectionType,
          'regular',
        );
        await pool.query(
          "UPDATE collection_log_schedules SET ends_at=now()+interval '1 hour'",
        );
        rules.worldPolicies.members = 'allow';
        await pool.query('UPDATE runelite_settings SET rules=$1', [
          JSON.stringify(rules),
        ]);
      },
    );

    await t.test(
      'concurrent automatic, manual and staff approvals produce one Event and all remaining Regular obtains',
      async () => {
        const a = await manual(3, false);
        const b = await manual(3, false);
        assert.equal(a.collectionType, 'event');
        assert.equal(b.collectionType, 'event');
        const results = await Promise.all([
          approve(a.id),
          approve(b.id),
          manual(3),
          rune(3).then((r) => r.receipt),
        ]);
        assert.ok(results.every((r) => r.status === 'approved'));
        assert.equal(
          results.filter((r) => r.collectionType === 'event').length,
          1,
        );
        assert.equal(
          results.filter((r) => r.collectionType === 'regular').length,
          3,
        );
        const audit = await detail(b.id);
        assert.equal(audit.audit[0]!.before.collectionType, 'event');
        assert.equal(
          audit.audit[0]!.after.collectionType,
          audit.submission.collectionType,
        );
      },
    );

    await t.test(
      'filter-on Event conflicts stay unchanged; disabling it permits approval fallback',
      async () => {
        await filter(true);
        await manual(4);
        const deferred = await rune(4);
        assert.equal(deferred.receipt.collectionType, 'event');
        assert.equal(deferred.receipt.status, 'pending');
        await assert.rejects(approve(deferred.receipt.submissionId), {
          status: 409,
        });
        await assert.rejects(manual(4), { status: 409 });
        const input = discordInput(4);
        const bot = await backend.submitClaim(input, claimHash(input));
        assert.equal(bot.receipt.collectionType, 'event');
        assert.equal(bot.receipt.creditOccupied, true);
        await filter(false);
        const approved = await approve(deferred.receipt.submissionId);
        assert.equal(approved.collectionType, 'regular');
        assert.equal(
          approved.collectionReason,
          'event_credit_already_obtained',
        );
        const audit = await detail(approved.id);
        assert.equal(audit.audit[0]!.before.collectionType, 'event');
        assert.equal(audit.audit[0]!.after.collectionType, 'regular');
        assert.equal((await manual(4)).collectionType, 'regular');
      },
    );

    await t.test(
      'pending, rejected and revoked claims do not occupy Event; hardcore stays independent',
      async () => {
        const pending = await manual(5, false);
        await review.mutate(
          pending.id,
          pending.version,
          {
            action: 'reject',
            expectedVersion: pending.version,
            reason: 'Invalid proof',
          },
          'owner',
          'Owner',
        );
        await manual(5, false);
        const revoked = await manual(5);
        assert.equal(revoked.collectionType, 'event');
        await revoke(revoked.id, revoked.version);
        const fresh = await rune(5);
        assert.equal(fresh.receipt.collectionType, 'event');
        assert.equal(fresh.receipt.status, 'approved');
        const hc = await proof.createRuneLite(
          { ...fields(5), worldTypes: ['HARDCORE_MAIN'] },
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(hc.receipt.collectionType, 'regular');
        assert.equal(hc.receipt.status, 'approved');
        assert.equal(
          (await detail(hc.receipt.submissionId)).submission.collectionReason,
          'hardcore',
        );
      },
    );

    await t.test(
      'approved flag and identity corrections use fallback without changing the Event holder',
      async () => {
        const original = await manual(6);
        const other = await manual(7);
        const moved = await review.mutate(
          other.id,
          other.version,
          {
            itemId: 6,
            collectorName: 'Moved collector',
            collectedOn: '2026-10-18',
            hardcore: false,
            collectionType: 'event',
            reason: 'Correct item',
          },
          'owner',
          'Owner',
        );
        assert.equal(moved.collectionType, 'regular');
        assert.equal(moved.collectionReason, 'event_credit_already_obtained');
        const flags = await review
          .mutate(
            moved.id,
            moved.version,
            {
              flags: { hardcore: false, collectionType: 'event' },
              reason: 'Recheck event eligibility',
            },
            'owner',
            'Owner',
          )
          .catch((error: unknown) => error);
        // Resolving to exactly the saved flags is a no-op, rather than a second Event credit.
        assert.equal((flags as { status: number }).status, 422);
        assert.equal(
          (await detail(original.id)).submission.collectionType,
          'event',
        );
        const keep = await review.mutate(
          original.id,
          original.version,
          {
            itemId: 6,
            collectorName: 'Corrected Event collector',
            collectedOn: '2026-10-18',
            hardcore: false,
            reason: 'Correct name',
          },
          'owner',
          'Owner',
        );
        assert.equal(keep.collectionType, 'event');
      },
    );
  },
);

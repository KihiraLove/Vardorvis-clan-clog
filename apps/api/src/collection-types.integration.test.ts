import { screenshotRecord } from './tests/screenshot.js';
/** Exercise real classification, independent credits and races across all write paths. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { defaultRuneLiteRules, type CollectionType } from '@clog/domain';
import { PgStore } from './store.js';
import { PgProofStore, type RuneLiteFields } from './proof-store.js';
import { PgReviewStore } from './review-store.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { intakeScheduling } from './intake-scheduling.js';
import { claimHash } from './intake.js';

test(
  'Regular/Event classification and credit rules are durable and transactional',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const schema = 'collection_types_' + randomUUID().replaceAll('-', '');
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
    });
    const directory = await mkdtemp(join(tmpdir(), 'clog-types-'));
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
    const backend = new PgStore(pool),
      proof = new PgProofStore(pool),
      review = new PgReviewStore(pool, backend);
    const keys = new PgClanKeyStore(pool, await loadClanKeyRoot(directory));
    await keys.ensureDefault();
    const key = (await keys.settings()).key;
    await pool.query(`INSERT INTO items(id,name) SELECT i,'Item '||i FROM generate_series(1,20) i;
    INSERT INTO game_item_ids(game_item_id,item_id) SELECT 900000+id,id FROM items;
    INSERT INTO game_item_ids(game_item_id,item_id) VALUES(990001,1);
    INSERT INTO pages(id,name,category,sort_order) VALUES('timed','Timed','bosses',0),('permanent','Permanent','bosses',1),('closed','Closed','bosses',2);
    INSERT INTO page_items(page_id,item_id,slot) VALUES('timed',1,0),('timed',4,1),('timed',6,2),('permanent',2,0),('permanent',4,1),('closed',3,0);
    INSERT INTO collection_permanent_pages(page_id) VALUES('permanent');
    UPDATE collection_scheduling SET enabled=true,version=7;
    INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES('00000000-0000-4000-8000-000000000001','Current event',now()-interval '1 hour',now()+interval '1 hour');
    INSERT INTO collection_log_schedule_pages(schedule_id,page_id) VALUES('00000000-0000-4000-8000-000000000001','timed'),('00000000-0000-4000-8000-000000000001','permanent');`);
    const runeFields = (
      itemId: number,
      hardcore = false,
      username = 'Collector',
    ): RuneLiteFields => ({
      username,
      clanName: 'Clan name',
      itemId: 900000 + itemId,
      itemName: 'Submitted ' + itemId,
      worldTypes: [hardcore ? 'HARDCORE_MAIN' : 'MEMBERS'],
      chatMessage: 'New item added to your collection log: Item ' + itemId,
    });
    const rune = (itemId: number, hardcore = false, username = 'Collector') =>
      proof.createRuneLite(
        runeFields(itemId, hardcore, username),
        undefined,
        randomUUID(),
        key,
      );
    let interaction = 100000000000000000n;
    const discord = async (itemId: number | undefined, hardcore = false) => {
      const input = {
        interactionId: String(interaction++),
        guildId: '123456789012345678',
        actorDiscordId: '234567890123456789',
        rawItemText:
          itemId === undefined ? 'Unrecognized item' : 'Item ' + itemId,
        collectorName: 'Collector',
        image: screenshotRecord(),
        hardcore,
        ...(itemId === undefined ? {} : { itemId }),
      };
      return backend.submitClaim(input, claimHash(input));
    };
    const manual = (
      itemId: number,
      type: CollectionType = 'regular',
      approve = true,
      hardcore = false,
      requestKey = randomUUID(),
    ) =>
      review.createManual(
        {
          itemId,
          collectorName: 'Repeat collector',
          collectedOn: '2026-10-18',
          hardcore,
          collectionType: type,
          approve,
        },
        'owner',
        'Owner',
        requestKey,
      );
    const approve = (id: string, version = 1) =>
      review.mutate(
        id,
        version,
        { action: 'approve', expectedVersion: version },
        'owner',
        'Owner',
      );
    const correction = (
      id: string,
      itemId: number,
      version: number,
      collectionType?: CollectionType,
      hardcore = false,
    ) =>
      review.mutate(
        id,
        version,
        {
          itemId,
          collectorName: 'Collector',
          collectedOn: '2026-10-18',
          hardcore,
          reason: 'Verified correction',
          ...(collectionType === undefined ? {} : { collectionType }),
        },
        'owner',
        'Owner',
      );

    await t.test(
      'both automatic sources classify timed/shared, permanent, closed, disabled and hardcore claims',
      async () => {
        for (const [id, type] of [
          [1, 'event'],
          [2, 'regular'],
          [3, 'regular'],
          [4, 'event'],
          [5, 'regular'],
        ] as const) {
          for (const r of [
            (await rune(id)).receipt,
            (await discord(id)).receipt,
          ])
            assert.equal(r.collectionType, type);
          assert.equal(
            (await rune(id, true)).receipt.collectionType,
            'regular',
          );
          assert.equal(
            (await discord(id, true)).receipt.collectionType,
            'regular',
          );
        }
        await pool.query('UPDATE collection_scheduling SET enabled=false');
        assert.equal(
          (await rune(1, false, 'Disabled schedule')).receipt.collectionType,
          'regular',
        );
        assert.equal((await discord(1)).receipt.collectionType, 'regular');
        await pool.query('UPDATE collection_scheduling SET enabled=true');
        assert.equal((await discord(undefined)).receipt.collectionType, null);
      },
    );
    await t.test(
      'UTC windows include start, exclude end and ignore permanent-page overlap',
      async () => {
        await pool.query(
          "INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES('00000000-0000-4000-8000-000000000002','Boundary','2020-01-01T12:00:00Z','2020-01-01T13:00:00Z'); INSERT INTO collection_log_schedule_pages(schedule_id,page_id) VALUES('00000000-0000-4000-8000-000000000002','closed'),('00000000-0000-4000-8000-000000000002','permanent')",
        );
        const client = await pool.connect();
        try {
          assert.equal(
            (
              await intakeScheduling(
                client,
                true,
                false,
                new Date('2020-01-01T11:59:59.999Z'),
              )
            ).eventPages.length,
            0,
          );
          const start = await intakeScheduling(
            client,
            true,
            false,
            new Date('2020-01-01T12:00:00Z'),
          );
          assert.deepEqual(
            start.eventPages.map((p) => p.pageId),
            ['closed'],
          );
          assert.equal(
            (
              await intakeScheduling(
                client,
                true,
                false,
                new Date('2020-01-01T13:00:00Z'),
              )
            ).eventPages.length,
            0,
          );
        } finally {
          client.release();
        }
      },
    );
    await t.test(
      'unmatched resolution uses original membership after windows and catalog membership change',
      async () => {
        const input = { ...runeFields(99), itemName: 'Unknown variant' };
        const original = await proof.createRuneLite(
          input,
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(original.receipt.collectionType, null);
        await pool.query(
          "UPDATE collection_log_schedules SET ends_at=now() WHERE title='Current event'; DELETE FROM page_items WHERE page_id='timed' AND item_id=6",
        );
        const resolved = await correction(original.receipt.submissionId, 6, 1);
        assert.equal(resolved.collectionType, 'event');
        assert.equal(resolved.status, 'pending');
        assert.equal(resolved.rawItemText, 'Unknown variant');
        const approved = await approve(resolved.id, resolved.version);
        assert.equal(approved.status, 'approved');
        const eventSnapshot = await backend.publicSnapshot('collections');
        const edited = await correction(
          approved.id,
          6,
          approved.version,
          'regular',
        );
        assert.equal(edited.collectionType, 'regular');
        assert.equal(edited.collectionReason, 'staff_correction');
        const regularSnapshot = await backend.publicSnapshot('collections');
        assert.notEqual(regularSnapshot.revision, eventSnapshot.revision);
        assert.equal(
          JSON.parse(regularSnapshot.body).credits.find(
            (c: { submissionId: string }) => c.submissionId === edited.id,
          ).collectionType,
          'regular',
        );
        const audit = (await review.detail(approved.id))!.audit[0]!;
        assert.equal(audit.before.collectionType, 'event');
        assert.equal(audit.after.collectionType, 'regular');
        const restored = await review.mutate(
          edited.id,
          edited.version,
          {
            itemId: 6,
            collectorName: edited.collectorName,
            collectedOn: edited.collectedOn,
            hardcore: false,
            useIntakeTiming: true,
            reason: 'Restore original event eligibility',
          },
          'owner',
          'Owner',
        );
        assert.equal(restored.collectionType, 'event');
        assert.equal(restored.collectionReason, 'timed_event');
        await pool.query(
          "UPDATE collection_log_schedules SET ends_at=now()+interval '1 hour' WHERE title='Current event'",
        );
        const unknownHC = await proof.createRuneLite(
          { ...runeFields(98, true) },
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(unknownHC.receipt.collectionType, 'regular');
      },
    );
    await t.test(
      'regular repeats and one Event coexist; immutable manual replay survives later filtering',
      async () => {
        const requestKey = randomUUID();
        const first = await manual(3, 'regular', true, false, requestKey);
        const second = await manual(3);
        const event = await manual(3, 'event');
        assert.notEqual(first.id, second.id);
        assert.equal(event.collectionType, 'event');
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=true',
        );
        assert.deepEqual(
          await manual(3, 'regular', true, false, requestKey),
          first,
        );
        await assert.rejects(manual(3), { status: 409 });
        await assert.rejects(manual(3, 'event'), { status: 409 });
        assert.equal(
          (await backend.collections()).filter(
            (c) => c.itemId === 3 && !c.hardcore,
          ).length,
          3,
        );
        const historicalEdit = await correction(second.id, 3, second.version);
        assert.equal(historicalEdit.status, 'approved');
        await review.mutate(
          event.id,
          event.version,
          {
            action: 'revoke',
            expectedVersion: event.version,
            reason: 'Replace incorrect event evidence',
          },
          'owner',
          'Owner',
        );
        assert.equal((await manual(3, 'event')).status, 'approved');
        const pending = await manual(3, 'event', false);
        await assert.rejects(approve(pending.id), { status: 409 });
        await assert.rejects(correction(first.id, 3, first.version, 'event'), {
          status: 409,
        });
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=false',
        );
        assert.equal((await manual(3)).status, 'approved');
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=true',
        );
        await assert.rejects(manual(3), { status: 409 });
      },
    );
    await t.test(
      'concurrent manual, staff and RuneLite approvals cannot bypass the regular filter',
      async () => {
        const pending = await manual(7, 'regular', false);
        const rules = defaultRuneLiteRules('Clan name');
        rules.worldPolicies.members = 'allow';
        rules.worldPolicies.hardcore = 'allow';
        await pool.query('UPDATE runelite_settings SET rules=$1', [
          JSON.stringify(rules),
        ]);
        await Promise.allSettled([
          manual(7),
          approve(pending.id),
          rune(7, false, 'Concurrent collector'),
        ]);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM submissions WHERE item_id=7 AND status='approved'",
            )
          ).rows[0].n,
          1,
        );
        const eventA = await manual(8, 'event', false),
          eventB = await manual(8, 'event', false);
        const eventResults = await Promise.allSettled([
          approve(eventA.id),
          approve(eventB.id),
          manual(8, 'event'),
        ]);
        assert.equal(
          eventResults.filter((r) => r.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM submissions WHERE item_id=8 AND status='approved' AND collection_type='event'",
            )
          ).rows[0].n,
          1,
        );
        assert.equal((await manual(8, 'regular')).status, 'approved');
      },
    );
    await t.test(
      'regular filtering is independent by world and cannot turn hardcore into Event',
      async () => {
        await manual(9);
        await manual(9, 'regular', true, true);
        await assert.rejects(manual(9, 'regular', true, true), { status: 409 });
        await assert.rejects(manual(10, 'event', true, true), { status: 422 });
        const hc = await manual(10, 'regular', false, true);
        await assert.rejects(correction(hc.id, 10, hc.version, 'event', true), {
          status: 422,
        });
        const auto = await rune(9, true, 'HC duplicate');
        assert.equal(auto.receipt.status, 'rejected');
        assert.equal(auto.receipt.collectionType, 'regular');
        assert.match(
          (await review.detail(auto.receipt.submissionId))!.submission
            .reviewReason!,
          /Filter out regular duplicates/u,
        );
      },
    );
    await t.test(
      'delivery deduplication remains independent from real repeated regular collections',
      async () => {
        await pool.query(
          'UPDATE submission_filter_settings SET filter_collected=false',
        );
        const fields = runeFields(11);
        const requestKey = randomUUID();
        const first = await proof.createRuneLite(
          fields,
          undefined,
          requestKey,
          key,
        );
        assert.equal(first.receipt.status, 'approved');
        const duplicate = await proof.createRuneLite(
          { ...fields, itemName: 'Other observer' },
          undefined,
          randomUUID(),
          key,
        );
        assert.equal(
          duplicate.receipt.submissionId,
          first.receipt.submissionId,
        );
        assert.equal(duplicate.receipt.duplicate, true);
        await pool.query(
          "UPDATE runelite_drop_events SET first_received_at=clock_timestamp()-interval '6 seconds' WHERE submission_id=$1",
          [first.receipt.submissionId],
        );
        const repeat = await proof.createRuneLite(
          fields,
          undefined,
          randomUUID(),
          key,
        );
        assert.notEqual(
          repeat.receipt.submissionId,
          first.receipt.submissionId,
        );
        assert.equal(repeat.receipt.status, 'approved');
        assert.deepEqual(
          (await proof.createRuneLite(fields, undefined, requestKey, key))
            .receipt,
          first.receipt,
        );
      },
    );
    await t.test(
      'legacy approved Regular credit never silently reclassifies during ordinary corrections',
      async () => {
        const id = randomUUID();
        const evidence = {
          receivedAt: '2026-10-18T12:00:00Z',
          enabled: true,
          revision: 'schedules-1',
          permanentlyOpenPageIds: [],
          eventPages: [{ scheduleId: 'old', pageId: 'old', itemIds: [12] }],
        };
        await pool.query(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,submitted_clan_name,game_item_id,chat_message,status,reviewed_at,reviewed_by,intake_scheduling) VALUES($1,'runelite','Legacy item',12,'Before','2026-10-18','submission_default','','Clan name',900012,'Original proof','approved',now(),'owner',$2)",
          [id, JSON.stringify(evidence)],
        );
        const corrected = await review.mutate(
          id,
          1,
          {
            itemId: 12,
            collectorName: 'After',
            collectedOn: '2026-10-18',
            hardcore: false,
            reason: 'Fix collector',
          },
          'owner',
          'Owner',
        );
        assert.equal(corrected.collectionType, 'regular');
        assert.equal(corrected.collectionReason, 'legacy');
        const explicit = await review.mutate(
          id,
          corrected.version,
          {
            itemId: 12,
            collectorName: 'After',
            collectedOn: '2026-10-18',
            hardcore: false,
            useIntakeTiming: true,
            reason: 'Explicitly restore original event eligibility',
          },
          'owner',
          'Owner',
        );
        assert.equal(explicit.collectionType, 'event');
      },
    );
    await t.test(
      'public history is complete beyond the former 20000-credit cap and never exposes private evidence',
      async () => {
        await pool.query(
          "INSERT INTO submissions(id,source,raw_item_text,item_id,collector_name,collected_on,date_source,proof_url,status,reviewed_by,reviewed_at) SELECT gen_random_uuid(),'manual','Item 20',20,'Collector '||i,'2026-10-18','admin','','approved','owner',now() FROM generate_series(1,20010) i",
        );
        const credits = await backend.collections();
        assert.equal(credits.filter((c) => c.itemId === 20).length, 20010);
        assert.ok(
          credits.every(
            (c) =>
              c.collectionType === 'regular' || c.collectionType === 'event',
          ),
        );
        assert.ok(!JSON.stringify(credits).includes('rawItemText'));
        assert.ok(!JSON.stringify(credits).includes('proofUrl'));
      },
    );
  },
);

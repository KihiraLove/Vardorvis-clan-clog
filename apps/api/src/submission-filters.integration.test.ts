import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { defaultRuneLiteRules } from '@clog/domain';
import { PgStore } from './store.js';
import { PgReviewStore } from './review-store.js';
import { PgProofStore } from './proof-store.js';
import { PgClanKeyStore } from './clan-api-key.js';
import { PgRuneLiteSettingsStore } from './runelite-settings.js';

test(
  'independent RuneLite observers share a fixed one-minute event and durable receipts; collected filtering is atomic and staff-controlled',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const schema = 'duplicate_filters_' + randomUUID().replaceAll('-', '');
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
      max: 12,
      statement_timeout: 10000,
    });
    try {
      const migrations = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(name, migrations), 'utf8'));
      await pool.query(
        "INSERT INTO items(id,name) VALUES(1,'One'),(2,'Two'),(3,'Three'); INSERT INTO game_item_ids(game_item_id,item_id) VALUES(1001,1),(1002,1),(1003,2),(1004,3)",
      );
      const keys = new PgClanKeyStore(pool, Buffer.alloc(32, 1));
      await keys.ensureDefault();
      const apiKey = (await keys.settings()).key;
      const proof = new PgProofStore(pool);
      const backend = new PgStore(pool);
      const reviews = new PgReviewStore(pool, backend);
      const image = () => ({
        id: randomUUID(),
        sha256: randomUUID().replaceAll('-', '').repeat(2),
        byteSize: 12,
        width: 1,
        height: 1,
      });
      const fields = (
        username = 'Player One',
        itemId = 1001,
        hardcore = false,
      ) => ({
        username,
        itemId,
        clanName: 'Clan name',
        worldTypes: hardcore ? ['HARDCORE_MAIN'] : ['MEMBERS'],
        chatMessage: `${username} received item ${itemId}.`,
      });
      const firstKey = randomUUID(),
        firstImage = image();
      const first = await proof.createRuneLite(
        fields(),
        firstImage,
        firstKey,
        apiKey,
      );
      const secondKey = randomUUID(),
        secondImage = image();
      const second = await proof.createRuneLite(
        fields(' player_one ', 1002),
        secondImage,
        secondKey,
        apiKey,
      );
      assert.equal(second.receipt.submissionId, first.receipt.submissionId);
      assert.equal(second.receipt.duplicate, true);
      assert.equal(second.imageId, firstImage.id);
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM submissions')).rows[0].n,
        1,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM submission_images'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM runelite_submission_requests',
          )
        ).rows[0].n,
        2,
      );
      await assert.rejects(
        proof.createRuneLite(
          fields('Different player'),
          secondImage,
          secondKey,
          apiKey,
        ),
        { status: 409 },
      );
      await pool.query(
        "UPDATE runelite_drop_events SET first_received_at=clock_timestamp()-interval '55 seconds' WHERE submission_id=$1",
        [first.receipt.submissionId],
      );
      const anchored = (
        await pool.query(
          'SELECT first_received_at FROM runelite_drop_events WHERE submission_id=$1',
          [first.receipt.submissionId],
        )
      ).rows[0].first_received_at;
      assert.equal(
        (
          await proof.createRuneLite(
            fields('PLAYER\u00a0ONE'),
            image(),
            randomUUID(),
            apiKey,
          )
        ).receipt.duplicate,
        true,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT first_received_at FROM runelite_drop_events WHERE submission_id=$1',
            [first.receipt.submissionId],
          )
        ).rows[0].first_received_at,
        anchored,
      );
      await pool.query(
        "UPDATE runelite_drop_events SET first_received_at=clock_timestamp()-interval '61 seconds' WHERE submission_id=$1",
        [first.receipt.submissionId],
      );
      assert.deepEqual(
        (
          await proof.createRuneLite(
            fields(' player_one ', 1002),
            secondImage,
            secondKey,
            apiKey,
          )
        ).receipt,
        second.receipt,
      );
      const later = await proof.createRuneLite(
        fields(),
        image(),
        randomUUID(),
        apiKey,
      );
      assert.notEqual(later.receipt.submissionId, first.receipt.submissionId);
      assert.equal(later.receipt.duplicate, undefined);
      const independentMode = await proof.createRuneLite(
        fields('Player One', 1001, true),
        image(),
        randomUUID(),
        apiKey,
      );
      assert.notEqual(
        independentMode.receipt.submissionId,
        later.receipt.submissionId,
      );
      const concurrent = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          proof.createRuneLite(
            fields(
              i % 2 ? 'Many_Observers' : 'many observers',
              i % 2 ? 1001 : 1002,
            ),
            image(),
            randomUUID(),
            apiKey,
          ),
        ),
      );
      assert.equal(
        new Set(concurrent.map((result) => result.receipt.submissionId)).size,
        1,
      );
      assert.equal(
        concurrent.filter((result) => result.receipt.duplicate).length,
        5,
      );
      // Correcting/reviewing the original claim does not change the observed drop identity.
      await pool.query(
        "UPDATE submissions SET collector_name='Staff correction' WHERE id=$1",
        [concurrent[0]!.receipt.submissionId],
      );
      assert.equal(
        (
          await proof.createRuneLite(
            fields('Many Observers'),
            image(),
            randomUUID(),
            apiKey,
          )
        ).receipt.duplicate,
        true,
      );

      let filters = await reviews.submissionFilters();
      assert.equal(filters.filterCollected, false);
      const oldRevision = filters.revision;
      filters = await reviews.saveSubmissionFilters(true, oldRevision, 'staff');
      await assert.rejects(
        reviews.saveSubmissionFilters(false, oldRevision, 'other-staff'),
        { status: 409 },
      );
      assert.deepEqual(
        (await reviews.queue('pending', false, 20)).filters,
        filters,
      );
      const settings = new PgRuneLiteSettingsStore(pool);
      const rules = defaultRuneLiteRules('Clan name');
      rules.worldPolicies.members = 'allow';
      await settings.update(
        { ...rules, expectedRevision: (await settings.settings()).revision },
        'staff',
      );
      const approvals = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          proof.createRuneLite(
            fields('New Player ' + i, 1003),
            image(),
            randomUUID(),
            apiKey,
          ),
        ),
      );
      assert.equal(
        approvals.filter(
          (result) =>
            result.status === 'fulfilled' &&
            result.value.receipt.status === 'approved',
        ).length,
        1,
      );
      assert.equal(
        approvals.filter(
          (result) =>
            result.status === 'rejected' && result.reason.status === 403,
        ).length,
        3,
      );
      await assert.rejects(
        backend.submitClaim(
          {
            interactionId: '900000000000000001',
            guildId: '900000000000000002',
            actorDiscordId: '900000000000000003',
            rawItemText: 'Two',
            itemId: 2,
            collectorName: 'Discord Player',
            proofUrl: 'https://imgur.com/proof',
            hardcore: false,
          },
          'hash',
        ),
        { status: 403 },
      );
      // A winning Discord delivery can commit (and gain credit) while its retry
      // waits for the item lock. The retry must recover that receipt, not reject it.
      const discordInput = {
        interactionId: '900000000000000004',
        guildId: '900000000000000002',
        actorDiscordId: '900000000000000003',
        rawItemText: 'Three',
        itemId: 3,
        collectorName: 'Discord winner',
        proofUrl: 'https://imgur.com/proof',
        hardcore: false,
      };
      const winnerHash = 'c'.repeat(64);
      const winner = await backend.submitClaim(discordInput, winnerHash);
      const saved = (
        await pool.query(
          'SELECT to_jsonb(s) AS row FROM submissions s WHERE id=$1',
          [winner.receipt.submissionId],
        )
      ).rows[0].row;
      await pool.query('DELETE FROM submissions WHERE id=$1', [
        winner.receipt.submissionId,
      ]);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM items WHERE id=3 FOR UPDATE');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        const retry = backend.submitClaim(discordInput, winnerHash);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = (
            await pool.query(
              'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
              [pid],
            )
          ).rows[0].waiting;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          waiting,
          true,
          'retry must wait behind the canonical item lock',
        );
        await blocker.query(
          'INSERT INTO submissions SELECT * FROM jsonb_populate_record(NULL::submissions,$1::jsonb)',
          [JSON.stringify(saved)],
        );
        await blocker.query(
          "UPDATE submissions SET status='approved',reviewed_at=clock_timestamp(),reviewed_by='staff',version=version+1 WHERE id=$1",
          [winner.receipt.submissionId],
        );
        await blocker.query('COMMIT');
        assert.deepEqual((await retry).receipt, winner.receipt);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const today = new Date().toISOString().slice(0, 10);
      const manual = await reviews.createManual(
        {
          itemId: 2,
          collectorName: 'Staff backfill',
          collectedOn: today,
          hardcore: false,
          approve: false,
        },
        'staff',
        'Staff',
        randomUUID(),
      );
      assert.equal(manual.status, 'pending');
      assert.equal(
        (
          await proof.createRuneLite(
            fields('HC Player', 1003, true),
            image(),
            randomUUID(),
            apiKey,
          )
        ).receipt.status,
        'pending',
      );
      filters = await reviews.saveSubmissionFilters(
        false,
        filters.revision,
        'staff',
      );
      assert.equal(
        (
          await proof.createRuneLite(
            fields('Another Player', 1003),
            image(),
            randomUUID(),
            apiKey,
          )
        ).receipt.status,
        'pending',
      );
      await pool.query(
        "CREATE FUNCTION fail_filter_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$; CREATE TRIGGER fail_filter_audit BEFORE INSERT ON submission_filter_audit FOR EACH ROW EXECUTE FUNCTION fail_filter_audit()",
      );
      await assert.rejects(
        reviews.saveSubmissionFilters(true, filters.revision, 'staff'),
      );
      assert.deepEqual(await reviews.submissionFilters(), filters);
    } finally {
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);

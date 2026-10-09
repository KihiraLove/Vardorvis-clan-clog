/** PostgreSQL intake verifies uniqueness, concurrency, durability and rollback. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from './app.js';
import { PgStore } from './store.js';
import type { BotSubmissionInput } from './types.js';

test(
  'durable intake and same/different concurrent retries on real PostgreSQL',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async () => {
    const schema = 'intake_test_' + randomUUID().replaceAll('-', '');
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString,
      options: '-c search_path=' + schema,
      statement_timeout: 5000,
      max: 8,
    });
    const token = 'a'.repeat(64);
    const guildId = '234567890123456789';
    const store = new PgStore(pool);
    const app = createApp(
      () => store.ready(),
      () => store.settings(),
      {
        store,
        bot: { token, guildId },
        logger: false,
      },
    );
    const headers = { authorization: 'Bearer ' + token };
    const claim: BotSubmissionInput = {
      interactionId: '345678901234567890',
      guildId,
      actorDiscordId: '123456789012345678',
      rawItemText: 'mYsTiC   aXe',
      collectorName: 'Snapshot',
      proofUrl: 'https://gyazo.com/record',
      hardcore: false,
    };
    const submit = (body: BotSubmissionInput) =>
      app.inject({
        url: '/api/v1/bot/submissions',
        method: 'POST',
        headers,
        payload: body,
      });
    try {
      for (const migration of [
        '001_initial.sql',
        '002_world_modes.sql',
        '003_admin_auth.sql',
        '004_bot_intake.sql',
      ])
        await pool.query(
          await readFile(
            new URL(
              '../../../packages/database/migrations/' + migration,
              import.meta.url,
            ),
            'utf8',
          ),
        );
      await pool.query(
        "INSERT INTO items(id,name,icon_path) VALUES (42,'Dragon axe','/42.png'),(43,'Dragon axe (or)','/43.png'),(44,'Mystic axe','/44.png')",
      );
      await pool.query(
        "INSERT INTO item_aliases(item_id,alias) VALUES(42,'D AXE'),(43,'Shared axe'),(44,'Shared axe')",
      );
      const search = await app.inject({
        url: '/api/v1/bot/items?q=d%20axe',
        headers,
      });
      assert.equal(search.statusCode, 200);
      assert.deepEqual(search.json().items[0], { id: 42, name: 'Dragon axe' });
      const first = await submit(claim);
      assert.equal(first.statusCode, 201);
      assert.equal(first.json().itemId, 44);
      assert.equal(first.json().creditOccupied, false);
      assert.equal(first.json().status, 'pending');
      assert.match(first.json().submittedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(
        first.json().collectedOn,
        first.json().submittedAt.slice(0, 10),
      );
      assert.equal(first.json().dateSource, 'submission_default');
      const copy = await submit(claim);
      assert.equal(copy.statusCode, 200);
      assert.deepEqual(copy.json(), first.json());
      assert.equal(
        (await submit({ ...claim, hardcore: true })).statusCode,
        409,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM submissions'))
          .rows[0].count,
        1,
      );
      const concurrentClaim = { ...claim, interactionId: '456789012345678901' };
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => submit(concurrentClaim)),
      );
      assert.deepEqual(
        concurrent.map((result) => result.statusCode).sort(),
        [200, 200, 200, 200, 200, 200, 200, 201],
      );
      concurrent.forEach((result) =>
        assert.deepEqual(result.json(), concurrent[0]!.json()),
      );
      const changedClaim = { ...claim, interactionId: '567890123456789012' };
      const mixed = await Promise.all([
        submit(changedClaim),
        submit({ ...changedClaim, hardcore: true }),
      ]);
      assert.deepEqual(
        mixed.map((result) => result.statusCode).sort(),
        [201, 409],
      );
      // A claim is never an approval. Existing credit is signaled explicitly per mode.
      await pool.query(
        "UPDATE submissions SET status='approved',reviewed_at=now(),reviewed_by='admin' WHERE discord_interaction_id=$1",
        [claim.interactionId],
      );
      const occupied = await submit({
        ...claim,
        interactionId: '678901234567890123',
      });
      assert.equal(occupied.statusCode, 201);
      assert.equal(occupied.json().creditOccupied, true);
      const hc = await submit({
        ...claim,
        interactionId: '789012345678901234',
        hardcore: true,
      });
      assert.equal(hc.json().creditOccupied, false);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM collection_credits',
          )
        ).rows[0].count,
        1,
      );
      // Alias ambiguity does not grant canonical credit; preserve raw claim.
      const ambiguous = await submit({
        ...claim,
        interactionId: '890123456789012345',
        rawItemText: 'Shared axe',
      });
      assert.equal(ambiguous.json().itemId, null);
      assert.equal(ambiguous.json().resolution, 'needs_match');
      const persisted = (
        await pool.query(
          'SELECT raw_item_text,collector_name,proof_url,hardcore,status FROM submissions WHERE discord_interaction_id=$1',
          ['890123456789012345'],
        )
      ).rows[0];
      assert.deepEqual(persisted, {
        raw_item_text: 'Shared axe',
        collector_name: 'Snapshot',
        proof_url: 'https://gyazo.com/record',
        hardcore: false,
        status: 'pending',
      });
      const today = new Date().toISOString().slice(0, 10);
      const overridden = await submit({
        ...claim,
        interactionId: '923456789012345678',
        collectedOn: today,
      } as BotSubmissionInput);
      assert.equal(
        overridden.statusCode,
        400,
        'Caller-supplied date is forbidden',
      );
      const dated = await submit({
        ...claim,
        interactionId: '923456789012345678',
        hardcore: true,
      });
      assert.equal(dated.statusCode, 201);
      assert.equal(dated.json().dateSource, 'submission_default');
      assert.equal(
        dated.json().collectedOn,
        dated.json().submittedAt.slice(0, 10),
      );
      // Failed SQL insert must not reserve the interaction ID or leave a partial receipt.
      await pool.query(
        "ALTER TABLE submissions ADD CONSTRAINT no_failure_name CHECK (collector_name <> 'Reject me')",
      );
      const failed = {
        ...claim,
        interactionId: '934567890123456789',
        collectorName: 'Reject me',
      };
      assert.equal((await submit(failed)).statusCode, 503);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM submissions WHERE discord_interaction_id=$1',
            [failed.interactionId],
          )
        ).rows[0].count,
        0,
      );
      const recovered = await submit({ ...failed, collectorName: 'Recovered' });
      assert.equal(recovered.statusCode, 201);
      const restarted = new PgStore(pool);
      const { claimHash } = await import('./intake.js');
      const retry = await restarted.submitClaim(claim, claimHash(claim));
      assert.equal(retry.created, false);
      assert.deepEqual(retry.receipt, first.json());
      assert.equal(
        (await app.inject({ url: '/api/v1/collections' })).json().credits
          .length,
        1,
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);

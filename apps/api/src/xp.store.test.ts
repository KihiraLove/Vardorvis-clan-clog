/** Disposable PostgreSQL acceptance for atomic import, refresh, replay and projections. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PgXpStore } from './xp-store.js';
import { createApp } from './app.js';
import { skillIds, type XpSnapshot } from './xp-types.js';

test(
  'XP-01 PostgreSQL import, unchanged and corrected refresh, stale preview, replay and audit',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = 'xp_test_' + randomUUID().replaceAll('-', '');
    const url = process.env.TEST_DATABASE_URL!;
    const root = new pg.Pool({ connectionString: url });
    await root.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({
      connectionString: url,
      options: '-c search_path=' + schema,
      max: 12,
    });
    const store = new PgXpStore(pool);
    const app = createApp(undefined, undefined, { xp: store, logger: false });
    const base = (
      id: number,
      skill: 'mining' | 'attack',
      amount: string,
    ): XpSnapshot => {
      const participants = [
        { playerId: 5, displayName: 'Five', gains: { [skill]: amount } },
      ];
      return {
        event: {
          id,
          title: 'SOTW ' + id,
          sourceUrl: 'https://wiseoldman.net/competitions/' + id,
          skills: [skill],
          gains: { [skill]: amount },
        },
        participants,
        sourceHash: 'f'.repeat(64),
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2026-09-08T00:00:00.000Z',
        sourceUpdatedAt: '2026-09-08T00:00:00.000Z',
      };
    };
    const key = () => randomUUID(),
      actor = '123456789012345678';
    try {
      for (const name of [
        '001_initial.sql',
        '002_world_modes.sql',
        '003_admin_auth.sql',
        '004_bot_intake.sql',
        '005_xp_events.sql',
      ])
        await pool.query(
          await readFile(
            new URL(
              '../../../packages/database/migrations/' + name,
              import.meta.url,
            ),
            'utf8',
          ),
        );
      const initial = await app.inject('/api/v1/xp/tracker');
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.json().revision, 'xp-1');
      assert.equal(initial.json().events.length, 0);
      assert.equal(Object.keys(initial.json().totals).length, skillIds.length);
      assert.equal(initial.json().totals.mining, '0');
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/xp/tracker',
            headers: { 'if-none-match': initial.headers.etag! },
          })
        ).statusCode,
        304,
      );
      const large = '9007199254740993';
      const first = base(1001, 'mining', large);
      const one = await store.preview(first, actor),
        requestKey = key();
      assert.equal(one.changes.find((c) => c.skill === 'mining')?.after, large);
      const concurrent = await Promise.all([
        store.apply(
          one.previewToken,
          one.expectedRevision,
          requestKey,
          actor,
          'Admin',
          false,
        ),
        store.apply(
          one.previewToken,
          one.expectedRevision,
          requestKey,
          actor,
          'Admin',
          false,
        ),
      ]);
      assert.deepEqual(concurrent, [
        { outcome: 'applied', revision: 'xp-2' },
        { outcome: 'applied', revision: 'xp-2' },
      ]);
      const read = await app.inject('/api/v1/xp/tracker');
      assert.equal(read.json().totals.mining, large);
      assert.equal(read.json().events[0].title, 'SOTW 1001');
      assert.equal(read.json().events[0].gains.mining, large);
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/xp/tracker',
            headers: { 'if-none-match': initial.headers.etag! },
          })
        ).statusCode,
        200,
      );
      assert.equal((await store.preview(first, actor)).changes[0]?.change, '0');
      const secondPreview = await store.preview(first, actor);
      const unchanged = await store.apply(
        secondPreview.previewToken,
        secondPreview.expectedRevision,
        key(),
        actor,
        'Admin',
        false,
      );
      assert.deepEqual(unchanged, { outcome: 'unchanged', revision: 'xp-2' });
      const second = base(1002, 'attack', '24');
      const additive = await store.preview(second, actor);
      assert.deepEqual(
        await store.apply(
          additive.previewToken,
          additive.expectedRevision,
          key(),
          actor,
          'Admin',
          false,
        ),
        { outcome: 'applied', revision: 'xp-3' },
      );
      const changed = {
        ...first,
        sourceHash: 'e'.repeat(64),
        event: { ...first.event, gains: { mining: '9007199254740900' } },
        participants: [
          {
            playerId: 5,
            displayName: 'Renamed',
            gains: { mining: '9007199254740900' },
          },
        ],
      };
      const preview = await store.preview(changed, actor);
      assert.equal(preview.changes[0]?.change, '-93');
      const stale = await store.preview(changed, actor);
      await assert.rejects(
        store.apply(
          preview.previewToken,
          preview.expectedRevision,
          key(),
          actor,
          'Admin',
          false,
        ),
        { status: 422 },
      );
      const corrected = await store.apply(
        preview.previewToken,
        preview.expectedRevision,
        key(),
        actor,
        'Admin',
        true,
      );
      assert.equal(corrected.revision, 'xp-4');
      assert.equal((await store.tracker()).totals.mining, '9007199254740900');
      assert.equal((await store.tracker()).totals.attack, '24');
      await assert.rejects(
        store.apply(
          stale.previewToken,
          stale.expectedRevision,
          key(),
          actor,
          'Admin',
          true,
        ),
        { status: 409 },
      );
      const replayKey = key(),
        same = await store.preview(changed, actor);
      const unchangedAgain = await store.apply(
        same.previewToken,
        same.expectedRevision,
        replayKey,
        actor,
        'Admin',
        false,
      );
      assert.equal(unchangedAgain.outcome, 'unchanged');
      await assert.rejects(
        store.apply(
          same.previewToken,
          same.expectedRevision,
          replayKey,
          actor,
          'Admin',
          true,
        ),
        { status: 409 },
      );
      const renamed = {
        ...changed,
        sourceHash: 'd'.repeat(64),
        participants: [
          {
            playerId: 5,
            displayName: 'Even newer',
            gains: { mining: '9007199254740900' },
          },
        ],
      };
      const beforeHash = (await store.tracker()).revision;
      const namePreview = await store.preview(renamed, actor);
      await store.apply(
        namePreview.previewToken,
        namePreview.expectedRevision,
        key(),
        actor,
        'Admin',
        false,
      );
      assert.notEqual((await store.tracker()).revision, beforeHash);
      const history = await store.history();
      assert.ok(history.imports.some((x) => x.outcome === 'unchanged'));
      assert.ok(
        history.imports.some((x) => x.changes.some((c) => c.change === '-93')),
      );
      assert.ok(
        !JSON.stringify(
          (await app.inject('/api/v1/xp/tracker')).json(),
        ).includes('playerId'),
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS count FROM xp_events'))
          .rows[0]?.count,
        2,
      );
    } finally {
      await app.close();
      await pool.end();
      await root.query('DROP SCHEMA ' + schema + ' CASCADE');
      await root.end();
    }
  },
);

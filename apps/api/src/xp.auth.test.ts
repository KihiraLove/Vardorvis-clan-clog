/** Route integration uses a fake provider and in-memory store; no live WOM/Discord. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { type AuthConfig } from './config.js';
import type { BackendStore, AdminIdentity, StoredSession } from './types.js';
import { parseWomSnapshot } from './wom.js';
import type { XpStore } from './xp-types.js';

const password = 'test-password-not-for-production';
const auth: AuthConfig = {
  origin: 'https://clog.example.com',
  secret: 'a'.repeat(64),
  passwordDigest: createHmac('sha256', Buffer.from('a'.repeat(64), 'hex'))
    .update('admin-password:')
    .update(password)
    .digest(),
  secure: true,
};
const source = {
  id: 9001,
  title: 'Mining week',
  metrics: [{ metric: 'mining', weight: 1 }],
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:05:00.000Z',
  participantCount: 1,
  participations: [
    {
      playerId: 1,
      player: { displayName: 'Miner' },
      deltas: [{ metric: 'mining', values: { gained: 50 } }],
    },
  ],
};
test('XP preview/apply/history require allowlisted browser session and CSRF; public tracker is isolated', async () => {
  const states = new Map<string, Date>(),
    sessions = new Map<string, StoredSession>();
  let fetched = 0,
    previewed = 0,
    applied = 0,
    history = 0;
  const store = {
    async createState(k: string, d: Date) {
      states.set(k, d);
    },
    async consumeState(k: string) {
      const d = states.get(k);
      states.delete(k);
      return !!d && d.getTime() > Date.now();
    },
    async createSession(k: string, u: AdminIdentity, d: Date) {
      sessions.set(k, { ...u, expiresAt: d });
    },
    async session(k: string) {
      return sessions.get(k) ?? null;
    },
    async deleteSession(k: string) {
      sessions.delete(k);
    },
    async allowLogin() {
      return true;
    },
  } as unknown as BackendStore;
  const token = 'A'.repeat(43);
  const xp = {
    async tracker() {
      return {
        revision: 'xp-1',
        totals: Object.fromEntries(
          [
            'attack',
            'hitpoints',
            'mining',
            'strength',
            'agility',
            'smithing',
            'defence',
            'herblore',
            'fishing',
            'ranged',
            'thieving',
            'cooking',
            'prayer',
            'crafting',
            'firemaking',
            'magic',
            'fletching',
            'woodcutting',
            'runecrafting',
            'slayer',
            'farming',
            'construction',
            'hunter',
            'sailing',
          ].map((k) => [k, '0']),
        ) as never,
        events: [],
      };
    },
    async preview() {
      previewed++;
      return { previewToken: token, expectedRevision: 'xp-1' } as never;
    },
    async apply() {
      applied++;
      return { outcome: 'applied', revision: 'xp-2' } as const;
    },
    async history() {
      history++;
      return { imports: [] };
    },
  } satisfies XpStore;
  const app = createApp(undefined, undefined, {
    store,
    auth,
    xp,
    logger: false,
    fetchWom: async () => {
      fetched++;
      return parseWomSnapshot(source, undefined, 9001);
    },
  });
  try {
    const path = '/api/v1/admin/xp/imports/preview';
    assert.equal((await app.inject('/api/v1/xp/tracker')).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          url: path,
          method: 'POST',
          payload: {
            competitionUrl: 'https://wiseoldman.net/competitions/9001',
          },
        })
      ).statusCode,
      401,
    );
    assert.equal(fetched, 0);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: auth.origin },
      payload: { password },
    });
    assert.equal(login.statusCode, 200);
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0]!;
    const session = (
      await app.inject({
        url: '/api/v1/auth/session',
        headers: { cookie: sessionCookie },
      })
    ).json();
    const headers = {
      cookie: sessionCookie,
      origin: auth.origin,
      'x-csrf-token': session.csrfToken,
    };
    const preview = async (
      h: Record<string, string>,
      payload: unknown = {
        competitionUrl: 'https://wiseoldman.net/competitions/9001',
      },
    ) =>
      app.inject({
        url: path,
        method: 'POST',
        headers: h,
        payload: payload as object,
      });
    assert.equal((await preview({ cookie: sessionCookie })).statusCode, 403);
    assert.equal(
      (await preview({ ...headers, origin: 'https://evil.com' })).statusCode,
      403,
    );
    assert.equal(
      (
        await preview(headers, {
          competitionUrl: 'https://wiseoldman.net/competitions/9001',
          actor: 'fake',
        })
      ).statusCode,
      400,
    );
    assert.equal(fetched, 0);
    const p = await preview(headers);
    assert.equal(p.statusCode, 200);
    assert.equal(previewed, 1);
    assert.equal(fetched, 1);
    const apply = await app.inject({
      url: '/api/v1/admin/xp/imports',
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': 'd8f6a414-d786-4c1a-9d21-d65191911fd2',
      },
      payload: {
        previewToken: token,
        expectedRevision: 'xp-1',
        acknowledgeCorrections: true,
      },
    });
    assert.equal(apply.statusCode, 200);
    assert.equal(applied, 1);
    const h = await app.inject({
      url: '/api/v1/admin/xp/imports',
      headers: { cookie: sessionCookie },
    });
    assert.equal(h.statusCode, 200);
    assert.equal(history, 1);
    assert.equal(h.headers['cache-control'], 'no-store');
    const bad = await app.inject({
      url: '/api/v1/admin/xp/imports',
      method: 'POST',
      headers,
      payload: { previewToken: token, expectedRevision: 'xp-1' },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(applied, 1);
  } finally {
    await app.close();
  }
});

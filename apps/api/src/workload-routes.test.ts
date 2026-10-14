import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { WorkBudget } from '@clog/domain';
import { createApp } from './app.js';
import { PasswordHasher } from './passwords.js';
import { PreviewWork } from './preview-work.js';
import type { BackendStore, StoredSession } from './types.js';
import type { PgCompetitionStore } from './competition-store.js';
import type { XpStore } from './xp-types.js';
import type { fetchCompetition } from './competition-wom.js';
import type { fetchWomCompetition } from './wom.js';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const origin = 'https://clog.example.com',
  secret = 'a'.repeat(64);
const digest = async (password: string, salt: Buffer) =>
  createHash('sha512').update(password).update(salt).digest();
const snapshot = {
  competition: {
    id: 1,
    kind: 'ACTIVITY' as const,
    title: 'Fixture',
    sourceUrl: 'https://wiseoldman.net/competitions/1',
    metrics: ['vardorvis'],
    startsAt: '2099-01-01T00:00:00.000Z',
    endsAt: '2099-01-02T00:00:00.000Z',
  },
  skills: [],
  lifecycle: 'future' as const,
};
const headers = (actor: string) => ({
  origin,
  cookie: '__Host-clog-session=' + actor.repeat(43),
  'x-csrf-token': createHmac('sha256', secret)
    .update('csrf:' + actor.repeat(43))
    .digest('base64url'),
});
async function fixture(
  options: {
    previews?: PreviewWork;
    passwords?: PasswordHasher;
    fetchCompetition?: typeof fetchCompetition;
    fetchWom?: typeof fetchWomCompetition;
  } = {},
) {
  const passwords = options.passwords ?? new PasswordHasher(undefined, digest);
  const encoded = await passwords.hash('good-password');
  const sessions = new Map<string, StoredSession>();
  for (const actor of ['a', 'b', 'c'])
    sessions.set(
      createHmac('sha256', secret)
        .update('session:' + actor.repeat(43))
        .digest('hex'),
      {
        id: actor,
        displayName: actor,
        accountVersion: 1,
        expiresAt: new Date(Date.now() + 60000),
      },
    );
  const attempts = new Map<string, number>();
  let previews = 0,
    applies = 0;
  const store = {
    ensureDefaultAdmin: async () => undefined,
    accountByUsername: async (name: string) =>
      name === 'admin'
        ? {
            id: 'a',
            username: name,
            role: 'admin',
            mustChangePassword: false,
            credentialVersion: 1,
            passwordHash: encoded,
          }
        : null,
    accountById: async (id: string) => ({
      id,
      username: id,
      role: 'admin',
      mustChangePassword: false,
      credentialVersion: 1,
      passwordHash: encoded,
    }),
    session: async (key: string) => sessions.get(key),
    createSession: async (
      key: string,
      session: Omit<StoredSession, 'expiresAt'>,
      expiresAt: Date,
    ) => {
      sessions.set(key, { ...session, expiresAt });
    },
    deleteSession: async (key: string) => {
      sessions.delete(key);
    },
    allowLogin: async (key: string) => {
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      return n <= 5;
    },
  } as unknown as BackendStore;
  const service = {
    clock: async () => Date.now(),
    preview: async () => {
      previews++;
      return { previewToken: 'x'.repeat(43) };
    },
    apply: async () => {
      applies++;
      return { receipt: 'original-durable-receipt' };
    },
  };
  const app = createApp(undefined, undefined, {
    logger: false,
    store,
    auth: { origin, secret, secure: true },
    passwords,
    competitions: service as unknown as PgCompetitionStore,
    xp: service as unknown as XpStore,
    ...options,
  });
  await app.ready();
  return { app, passwords, attempts, counts: () => ({ previews, applies }) };
}
test('both preview routes share account/global budgets and keep apply/replay available during overload', async () => {
  let now = 0,
    fetched = 0,
    legacy = 0;
  const previews = new PreviewWork(
    new WorkBudget(
      { concurrent: 2, perMinute: 3 },
      [{ concurrent: 1, perMinute: 2 }],
      10,
      () => now,
    ),
  );
  const gates: (() => void)[] = [];
  const { app, counts } = await fixture({
    previews,
    fetchCompetition: async () => {
      fetched++;
      await new Promise<void>((resolve) => gates.push(resolve));
      return snapshot;
    },
    fetchWom: async () => {
      legacy++;
      return {} as never;
    },
  });
  const post = (actor: string, url = '/api/v1/admin/competitions/preview') =>
    app.inject({
      method: 'POST',
      url,
      headers: headers(actor),
      payload: { competitionUrl: snapshot.competition.sourceUrl },
    });
  try {
    const first = post('a');
    void first.then(() => undefined);
    while (!gates.length) await tick();
    const same = await post('a', '/api/v1/admin/xp/imports/preview');
    assert.equal(same.statusCode, 429);
    assert.equal(same.headers['retry-after'], '1');
    const second = post('b');
    void second.then(() => undefined);
    while (gates.length < 2) await tick();
    assert.equal((await post('c')).statusCode, 429);
    gates.shift()!();
    gates.shift()!();
    assert.equal((await first).statusCode, 200);
    assert.equal((await second).statusCode, 200);
    assert.equal(
      (await post('a', '/api/v1/admin/xp/imports/preview')).statusCode,
      200,
    );
    const limit = await post('c');
    assert.equal(limit.statusCode, 429);
    assert.equal(limit.headers['retry-after'], '60');
    assert.equal(fetched, 2);
    assert.equal(legacy, 1);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/competitions/imports',
      headers: {
        ...headers('a'),
        'idempotency-key': '00000000-0000-4000-8000-000000000001',
      },
      payload: {
        previewToken: 'x'.repeat(43),
        expectedRevision: 'xp-1',
        scheduleRevision: 'schedules-1',
      },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().receipt, 'original-durable-receipt');
    now = 60000;
    assert.equal(
      (await post('a', '/api/v1/admin/xp/imports/preview')).statusCode,
      200,
    );
    assert.deepEqual(counts(), { previews: 4, applies: 1 });
    assert.equal(previews.budget.snapshot().active, 0);
  } finally {
    await app.close();
  }
});
test('a disconnected preview cancels provider work and returns its shared slot', async () => {
  const previews = new PreviewWork();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { app, counts } = await fixture({
    previews,
    fetchCompetition: async (_url, _now, _request, signal) => {
      started();
      return new Promise((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('canceled')), {
          once: true,
        }),
      );
    },
  });
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const pending = fetch(address + '/api/v1/admin/competitions/preview', {
      method: 'POST',
      headers: { ...headers('a'), 'content-type': 'application/json' },
      body: JSON.stringify({ competitionUrl: snapshot.competition.sourceUrl }),
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    await assert.rejects(pending);
    const deadline = Date.now() + 2000;
    while (previews.budget.snapshot().active && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(previews.budget.snapshot().active, 0);
    assert.deepEqual(counts(), { previews: 0, applies: 0 });
  } finally {
    await app.close();
  }
});
test('many login IPs cannot exceed the shared hash budget; 429, IP limits and good/bad auth recover', async () => {
  let gated = false;
  const gates: (() => void)[] = [];
  const passwords = new PasswordHasher(
    { concurrent: 2, queued: 4, waitMs: 1000 },
    async (password, salt) => {
      if (gated) await new Promise<void>((resolve) => gates.push(resolve));
      return digest(password, salt);
    },
  );
  const { app, attempts } = await fixture({ passwords });
  const login = (ip: string, password = 'good-password') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      headers: { origin },
      payload: { username: 'admin', password },
    });
  try {
    gated = true;
    const jobs = Array.from({ length: 6 }, (_, i) =>
      login('192.0.2.' + (i + 1)),
    );
    for (const job of jobs) void job.then(() => undefined);
    while (passwords.snapshot().queued < 4) await tick();
    const denied = await Promise.all(
      Array.from({ length: 20 }, (_, i) => login('198.51.100.' + (i + 1))),
    );
    assert.ok(
      denied.every(
        (r) => r.statusCode === 429 && r.headers['retry-after'] === '1',
      ),
    );
    assert.ok(
      denied.every(
        (r) => !r.body.includes('scrypt') && !r.body.includes('good-password'),
      ),
    );
    for (let i = 0; i < 6; i++) {
      gates.shift()!();
      await tick();
    }
    assert.ok((await Promise.all(jobs)).every((r) => r.statusCode === 200));
    gated = false;
    assert.equal((await login('203.0.113.1', 'wrong')).statusCode, 401);
    assert.equal((await login('203.0.113.2')).statusCode, 200);
    for (let i = 0; i < 5; i++)
      assert.equal((await login('203.0.113.3', 'wrong')).statusCode, 401);
    const limited = await login('203.0.113.3');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal(attempts.size, 29);
  } finally {
    gated = false;
    for (const finish of gates) finish();
    await app.close();
  }
});

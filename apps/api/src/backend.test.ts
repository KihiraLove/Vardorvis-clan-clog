/** Route/security tests use a disposable store, never real Discord credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { readConfig, type AuthConfig } from './config.js';
import { createHmac } from 'node:crypto';
import type {
  AdminIdentity,
  BackendStore,
  CatalogData,
  PublicCredit,
  Settings,
  StoredSession,
} from './types.js';
const admin = 'password-admin';
const password = 'test-password-not-for-production';
const config: AuthConfig = {
  origin: 'https://clog.example.com',
  secret: 'a'.repeat(64),
  passwordDigest: createHmac('sha256', Buffer.from('a'.repeat(64), 'hex'))
    .update('admin-password:').update(password).digest(),
  secure: true,
};
export class MemoryStore implements BackendStore {
  state = new Map<string, Date>();
  sessions = new Map<string, StoredSession>();
  attempts = 0;
  setting: Settings = { revision: 'settings-1', hardcoreEnabled: false };
  audits: { actor: string; enabled: boolean }[] = [];
  data: CatalogData = {
    items: [{ id: 42, name: 'Shared item', iconPath: '/items/42.png' }],
    pages: [
      { id: 'a', name: 'A', category: 'bosses', itemIds: [42] },
      { id: 'b', name: 'B', category: 'bosses', itemIds: [42] },
    ],
  };
  credits: PublicCredit[] = [];
  async ready() {}
  async botItems() {
    return [];
  }
  async submitClaim(): Promise<never> {
    throw new Error('Not configured in this test.');
  }
  async catalog() {
    return this.data;
  }
  async collections() {
    return this.credits;
  }
  async settings() {
    return { ...this.setting };
  }
  async saveSettings(enabled: boolean, revision: string, actor: string) {
    if (this.setting.revision !== revision) return null;
    this.setting = {
      revision: 'settings-' + (Number(revision.split('-')[1]) + 1),
      hardcoreEnabled: enabled,
    };
    this.audits.push({ actor, enabled });
    return this.settings();
  }
  async createState(hash: string, date: Date) {
    this.state.set(hash, date);
  }
  async consumeState(hash: string) {
    const d = this.state.get(hash);
    if (!d || d.getTime() <= Date.now()) return false;
    this.state.delete(hash);
    return true;
  }
  async createSession(hash: string, identity: AdminIdentity, date: Date) {
    this.sessions.set(hash, { ...identity, expiresAt: date });
  }
  async session(hash: string) {
    return this.sessions.get(hash) ?? null;
  }
  async deleteSession(hash: string) {
    this.sessions.delete(hash);
  }
  async allowLogin() {
    return ++this.attempts <= 20;
  }
}
function fixture() {
  const store = new MemoryStore();
  const auth = { ...config };
  const app = createApp(
    () => store.ready(),
    () => store.settings(),
    { store, auth, logger: false },
  );
  return { app, store, auth };
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { origin: config.origin },
    payload: { password },
  });
  assert.equal(response.statusCode, 200);
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Lax; Max-Age=28800; Secure/u);
  const session = await app.inject({
    url: '/api/v1/auth/session', headers: { cookie },
  });
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.equal(session.json().authenticated, true);
  return {
    cookie, origin: config.origin,
    'x-csrf-token': session.json().csrfToken as string,
  };
}
test('public snapshots have stable ETags, isolated world credits and automatic content invalidation', async () => {
  const { app, store } = fixture();
  try {
    store.credits = [
      {
        submissionId: 'one',
        itemId: 42,
        collectorName: 'Normal',
        collectedOn: '2026-10-01',
        hardcore: false,
      },
      {
        submissionId: 'two',
        itemId: 42,
        collectorName: 'Hardcore',
        collectedOn: '2026-10-02',
        hardcore: true,
      },
    ];
    const catalog = await app.inject('/api/v1/catalog');
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(
      catalog.json().pages.map((p: { itemIds: number[] }) => p.itemIds),
      [[42], [42]],
    );
    const first = await app.inject('/api/v1/collections');
    assert.equal(first.json().credits.length, 2);
    assert.deepEqual(Object.keys(first.json().credits[0]).sort(), [
      'collectedOn',
      'collectorName',
      'hardcore',
      'itemId',
      'submissionId',
    ]);
    const unchanged = await app.inject({
      url: '/api/v1/collections',
      headers: { 'if-none-match': '"other", W/' + first.headers.etag },
    });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, '');
    store.credits.pop();
    const changed = await app.inject({
      url: '/api/v1/collections',
      headers: { 'if-none-match': first.headers.etag! },
    });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, first.headers.etag);
    store.data.pages[0]!.itemIds = [];
    assert.notEqual(
      (await app.inject('/api/v1/catalog')).headers.etag,
      catalog.headers.etag,
    );
  } finally {
    await app.close();
  }
});
test('password login rejects missing origin, bad credentials and anonymous admin reads', async () => {
  const { app, store } = fixture();
  try {
    assert.equal((await app.inject('/api/v1/admin/settings')).statusCode, 401);
    assert.deepEqual((await app.inject('/api/v1/auth/session')).json(), {
      authenticated: false,
    });
    assert.equal((await app.inject('/api/v1/auth/discord')).statusCode, 404);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { password },
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: config.origin }, payload: { password: 'wrong' },
    })).statusCode, 401);
    assert.equal(store.sessions.size, 0);
    const headers = await login(app);
    assert.equal((await app.inject({
      url: '/api/v1/admin/settings', headers,
    })).statusCode, 200);
  } finally { await app.close(); }
});
test('settings require origin, CSRF, strict fields and current revision; every saved write is audited', async () => {
  const { app, store } = fixture();
  try {
    const headers = await login(app);
    const payload = { hardcoreEnabled: true, expectedRevision: 'settings-1' };
    for (const bad of [
      { cookie: headers.cookie },
      { ...headers, origin: 'https://evil.example' },
      { ...headers, 'x-csrf-token': 'x'.repeat(43) },
    ])
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/admin/settings',
            headers: bad,
            payload,
          })
        ).statusCode,
        403,
      );
    for (const invalid of [
      { ...payload, actor: 'spoof' },
      { ...payload, hardcoreEnabled: 'true' },
    ])
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/admin/settings',
            headers,
            payload: invalid,
          })
        ).statusCode,
        400,
      );
    assert.equal(store.audits.length, 0);
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers,
      payload,
    });
    assert.deepEqual(saved.json(), {
      revision: 'settings-2',
      hardcoreEnabled: true,
    });
    assert.equal(saved.headers['cache-control'], 'no-store');
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers,
          payload,
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(store.audits, [{ actor: admin, enabled: true }]);
    assert.equal(
      (await app.inject('/api/v1/settings')).json().hardcoreEnabled,
      true,
    );
    const off = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      headers,
      payload: { hardcoreEnabled: false, expectedRevision: 'settings-2' },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(store.audits.length, 2);
  } finally {
    await app.close();
  }
});
test('logout revokes the password session and expired or changed identities fail closed', async () => {
  const { app, store } = fixture();
  try {
    const headers = await login(app);
    assert.equal((await app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { cookie: headers.cookie },
    })).statusCode, 403);
    const out = await app.inject({
      method: 'POST', url: '/api/v1/auth/logout', headers,
    });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/u);
    assert.equal(store.sessions.size, 0);
    assert.equal((await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode, 401);
    const expired = await login(app);
    for (const session of store.sessions.values()) session.expiresAt = new Date(0);
    assert.equal((await app.inject({ url: '/api/v1/admin/settings', headers: expired })).statusCode, 401);
    const invalid = await login(app);
    for (const session of store.sessions.values()) session.id = 'other-identity';
    assert.equal((await app.inject({ url: '/api/v1/admin/settings', headers: invalid })).statusCode, 401);
  } finally { await app.close(); }
});
test('login rate limits and config fail closed without a valid admin password', async () => {
  const { app, store } = fixture();
  try {
    store.attempts = 20;
    const blocked = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: config.origin }, payload: { password },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers['retry-after'], '60');
  } finally { await app.close(); }
  const env = {
    NODE_ENV: 'production',
    AUTH_ENABLED: 'true',
    PUBLIC_ORIGIN: config.origin,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: config.secret,
  };
  assert.equal(readConfig(env).auth?.secure, true);
  assert.equal(readConfig({}).auth, undefined);
  for (const patch of [
    { PUBLIC_ORIGIN: 'http://clog.example.com' },
    { SESSION_SECRET: 'weak' },
    { ADMIN_PASSWORD: 'short' },
    { ADMIN_PASSWORD: '' },
    { AUTH_ENABLED: 'maybe' },
    { TRUSTED_PROXY_CIDRS: 'true' },
  ])
    assert.throws(() => readConfig({ ...env, ...patch }));
  assert.deepEqual(
    readConfig({ ...env, TRUSTED_PROXY_CIDRS: '127.0.0.1,172.18.0.0/16' }).trustProxy,
    ['127.0.0.1', '172.18.0.0/16'],
  );
});

/** Opt-in passwordless admin is browser-local and impossible under production config. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import type {
  AdminIdentity,
  BackendStore,
  Settings,
  StoredSession,
} from './types.js';

const config = {
  NODE_ENV: 'development',
  DEV_ADMIN_MODE: 'true',
  AUTH_ENABLED: 'false',
  PUBLIC_ORIGIN: 'http://127.0.0.1:8088',
};
function disposableStore() {
  const sessions = new Map<string, StoredSession>();
  let settings: Settings = {
    revision: 'settings-1',
    clanName: 'Vardorvis',
    hardcoreEnabled: false,
  };
  const audits: string[] = [];
  const store: BackendStore = {
    ensureDefaultAdmin: async () => {},
    accountByUsername: async () => null,
    accountById: async () => null,
    accounts: async () => [],
    createModerator: async () => {
      throw new Error('Unavailable in local test mode.');
    },
    updateAccount: async () => {
      throw new Error('Unavailable in local test mode.');
    },
    ready: async () => {},
    botItems: async () => [],
    submitClaim: async () => {
      throw new Error('Test bot intake not configured.');
    },
    catalog: async () => ({
      items: [{ id: 1, name: 'One', iconPath: '/items/1.png' }],
      pages: [{ id: 'one', name: 'One', category: 'bosses', itemIds: [1] }],
    }),
    collections: async () => [],
    settings: async () => settings,
    saveSettings: async (enabled: boolean, revision: string, actor: string) => {
      if (revision !== settings.revision) return null;
      settings = {
        revision: 'settings-' + (Number(revision.split('-')[1]) + 1),
        clanName: 'Vardorvis',
        hardcoreEnabled: enabled,
      };
      audits.push(actor);
      return settings;
    },
    createState: async () => {},
    consumeState: async () => false,
    createSession: async (
      key: string,
      identity: AdminIdentity,
      expiresAt: Date,
    ) => {
      sessions.set(key, { ...identity, expiresAt });
    },
    session: async (key: string) => sessions.get(key) ?? null,
    deleteSession: async (key: string) => {
      sessions.delete(key);
    },
    allowLogin: async () => true,
  };
  return { store, sessions, audits };
}
test('local admin flag is opt-in and forbidden on production, public origins or trusted proxies', () => {
  assert.equal(readConfig({}).auth, undefined);
  assert.equal(readConfig(config).auth?.devOnly, true);
  assert.equal(readConfig(config).auth?.secure, false);
  for (const patch of [
    { NODE_ENV: 'production' },
    { NODE_ENV: undefined },
    { AUTH_ENABLED: 'true' },
    { PUBLIC_ORIGIN: 'https://daybloom.net' },
    { PUBLIC_ORIGIN: 'http://public.example' },
    { PUBLIC_ORIGIN: 'https://127.0.0.1:8088' },
    { PUBLIC_ORIGIN: 'http://127.0.0.1:8088/elsewhere' },
    { TRUSTED_PROXY_CIDRS: '127.0.0.1' },
    { DEV_ADMIN_MODE: 'maybe' },
  ])
    assert.throws(() => readConfig({ ...config, ...patch }));
});
test('fresh localhost browser can review and save with CSRF but no login', async () => {
  const { store, sessions, audits } = disposableStore();
  const auth = readConfig(config).auth!;
  const app = createApp(
    () => store.ready(),
    () => store.settings(),
    { store, auth, logger: false },
  );
  const host = '127.0.0.1:8088';
  try {
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/settings',
          headers: { host },
        })
      ).statusCode,
      401,
    );
    const first = await app.inject({
      url: '/api/v1/auth/session',
      headers: { host },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.json().authenticated, true);
    assert.equal(first.json().development, true);
    assert.equal(first.json().displayName, 'Local test admin');
    assert.match(
      String(first.headers['set-cookie']),
      /HttpOnly; SameSite=Lax/u,
    );
    assert.doesNotMatch(String(first.headers['set-cookie']), /; Secure/u);
    const cookie = String(first.headers['set-cookie']).split(';')[0]!;
    assert.equal(sessions.size, 1);
    const next = await app.inject({
      url: '/api/v1/auth/session',
      headers: { host, cookie },
    });
    assert.equal(next.headers['set-cookie'], undefined);
    assert.equal(next.json().csrfToken, first.json().csrfToken);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/settings',
          headers: { host, cookie },
        })
      ).statusCode,
      200,
    );
    const request = {
      method: 'PUT' as const,
      url: '/api/v1/admin/settings',
      payload: { hardcoreEnabled: true, expectedRevision: 'settings-1' },
    };
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { host, cookie, origin: auth.origin },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: {
            host,
            cookie,
            origin: 'http://evil.example',
            'x-csrf-token': first.json().csrfToken,
          },
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({
      ...request,
      headers: {
        host,
        cookie,
        origin: auth.origin,
        'x-csrf-token': first.json().csrfToken,
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().hardcoreEnabled, true);
    assert.deepEqual(audits, ['local-dev-admin']);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/auth/discord',
          headers: { host },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/auth/discord/callback?code=fake',
          headers: { host },
        })
      ).statusCode,
      404,
    );
    for (const bad of [
      { host: 'daybloom.net', cookie },
      { host, cookie, 'x-forwarded-host': 'daybloom.net' },
    ]) {
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/admin/settings',
            headers: bad,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/v1/auth/session',
            headers: bad,
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(sessions.size, 1);
  } finally {
    await app.close();
  }
});

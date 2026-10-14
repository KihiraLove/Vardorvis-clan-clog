/** Route/security tests use a disposable store, never real Discord credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { readConfig, type AuthConfig } from './config.js';
import { createHmac, randomUUID } from 'node:crypto';
import { hashPassword } from './passwords.js';
import { ApiError, type StoredAccount, type StaffAccount } from './types.js';
import type { ReviewStore } from './review-types.js';
import type { XpStore } from './xp-types.js';
import type {
  AccountSessionIdentity,
  BackendStore,
  CatalogData,
  PublicCredit,
  Settings,
  StoredSession,
} from './types.js';
const admin = '00000000-0000-4000-8000-000000000001';
const password = 'test-password-not-for-production';
const bootstrapPassword = 'b'.repeat(64);
const testPasswordHash = await hashPassword(password);
const config: AuthConfig = {
  origin: 'https://clog.example.com',
  secret: 'a'.repeat(64),
  secure: true,
};
export class MemoryStore implements BackendStore {
  staff = new Map<string, StoredAccount>([
    [
      admin,
      {
        id: admin,
        username: 'admin',
        role: 'admin',
        mustChangePassword: false,
        credentialVersion: 1,
        passwordHash: testPasswordHash,
      },
    ],
  ]);
  async ensureDefaultAdmin(passwordHash?: string) {
    if ([...this.staff.values()].some((account) => account.role === 'admin'))
      return;
    if (!passwordHash)
      throw new Error('No administrator exists. Set ADMIN_BOOTSTRAP_PASSWORD.');
    this.staff.set(admin, {
      id: admin,
      username: 'admin',
      role: 'admin',
      passwordHash,
      credentialVersion: 1,
      mustChangePassword: true,
    });
  }
  async accountByUsername(username: string) {
    return (
      [...this.staff.values()].find(
        (account) => account.username.toLowerCase() === username.toLowerCase(),
      ) ?? null
    );
  }
  async accountById(id: string) {
    return this.staff.get(id) ?? null;
  }
  async accounts(): Promise<StaffAccount[]> {
    return [...this.staff.values()].map(
      ({ id, username, role, mustChangePassword }) => ({
        id,
        username,
        role,
        mustChangePassword,
      }),
    );
  }
  async createModerator(username: string, passwordHash: string) {
    if (await this.accountByUsername(username))
      throw new ApiError(409, 'That username is already in use.');
    const account: StoredAccount = {
      id: randomUUID(),
      username,
      role: 'moderator',
      passwordHash,
      credentialVersion: 1,
      mustChangePassword: true,
    };
    this.staff.set(account.id, account);
    const { id, role, mustChangePassword } = account;
    return { id, username, role, mustChangePassword };
  }
  async updateAccount(
    id: string,
    expectedVersion: number,
    username: string,
    passwordHash?: string,
  ) {
    const account = this.staff.get(id);
    if (!account || account.credentialVersion !== expectedVersion)
      throw new ApiError(
        409,
        'Your account changed. Sign in again before retrying.',
      );
    const existing = await this.accountByUsername(username);
    if (existing && existing.id !== id)
      throw new ApiError(409, 'That username is already in use.');
    const next = {
      ...account,
      username,
      passwordHash: passwordHash ?? account.passwordHash,
      mustChangePassword: passwordHash ? false : account.mustChangePassword,
      credentialVersion: expectedVersion + 1,
    };
    this.staff.set(id, next);
    for (const [key, session] of this.sessions)
      if (session.id === id) this.sessions.delete(key);
    return next;
  }
  state = new Map<string, Date>();
  sessions = new Map<string, StoredSession>();
  attempts = 0;
  setting: Settings = {
    revision: 'settings-1',
    clanName: 'Vardorvis',
    hardcoreEnabled: false,
  };
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
      clanName: 'Vardorvis',
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
  async createSession(
    hash: string,
    identity: AccountSessionIdentity,
    date: Date,
  ) {
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
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: config.origin },
    payload: { username: 'admin', password },
  });
  assert.equal(response.statusCode, 200);
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  assert.match(
    String(response.headers['set-cookie']),
    /HttpOnly; SameSite=Lax; Max-Age=28800; Secure/u,
  );
  const session = await app.inject({
    url: '/api/v1/auth/session',
    headers: { cookie },
  });
  assert.equal(session.headers['cache-control'], 'no-store');
  assert.equal(session.json().authenticated, true);
  return {
    cookie,
    origin: config.origin,
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
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username: 'admin', password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: config.origin },
          payload: { username: 'admin', password: 'wrong' },
        })
      ).statusCode,
      401,
    );
    assert.equal(store.sessions.size, 0);
    const headers = await login(app);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/settings',
          headers,
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
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
      clanName: 'Vardorvis',
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
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: { cookie: headers.cookie },
        })
      ).statusCode,
      403,
    );
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers,
    });
    assert.equal(out.statusCode, 204);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/u);
    assert.equal(store.sessions.size, 0);
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode,
      401,
    );
    const expired = await login(app);
    for (const session of store.sessions.values())
      session.expiresAt = new Date(0);
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/settings', headers: expired }))
        .statusCode,
      401,
    );
    const invalid = await login(app);
    for (const session of store.sessions.values())
      session.id = 'other-identity';
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/settings', headers: invalid }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test('login rate limits and config fail closed without valid session configuration', async () => {
  const { app, store } = fixture();
  try {
    store.attempts = 20;
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: config.origin },
      payload: { username: 'admin', password },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers['retry-after'], '60');
  } finally {
    await app.close();
  }
  const env = {
    NODE_ENV: 'production',
    AUTH_ENABLED: 'true',
    PUBLIC_ORIGIN: config.origin,
    SESSION_SECRET: config.secret,
  };
  assert.equal(readConfig(env).auth?.secure, true);
  assert.equal(readConfig({}).auth, undefined);
  for (const patch of [
    { PUBLIC_ORIGIN: 'http://clog.example.com' },
    { SESSION_SECRET: 'weak' },
    { ADMIN_BOOTSTRAP_PASSWORD: 'admin' },
    { ADMIN_BOOTSTRAP_PASSWORD: 'a'.repeat(63) },
    { ADMIN_BOOTSTRAP_PASSWORD: 'a'.repeat(257) },
    { ADMIN_BOOTSTRAP_PASSWORD: ' ' + bootstrapPassword },
    { AUTH_ENABLED: 'maybe' },
    { TRUSTED_PROXY_CIDRS: 'true' },
  ])
    assert.throws(() => readConfig({ ...env, ...patch }));
  assert.equal(
    readConfig({ ...env, ADMIN_BOOTSTRAP_PASSWORD: bootstrapPassword }).auth
      ?.bootstrapPassword,
    bootstrapPassword,
  );
  assert.equal(
    readConfig({ ...env, ADMIN_BOOTSTRAP_PASSWORD: '' }).auth
      ?.bootstrapPassword,
    undefined,
  );
  assert.deepEqual(
    readConfig({ ...env, TRUSTED_PROXY_CIDRS: '127.0.0.1,172.18.0.0/16' })
      .trustProxy,
    ['127.0.0.1', '172.18.0.0/16'],
  );
});

test('retired admin environment flag cannot enable staff tools or bypass the session secret', async () => {
  const env = {
    NODE_ENV: 'development',
    DEV_ADMIN_MODE: 'true',
    AUTH_ENABLED: 'false',
    PUBLIC_ORIGIN: 'http://127.0.0.1:8088',
  };
  assert.equal(readConfig(env).auth, undefined);
  assert.throws(
    () => readConfig({ ...env, AUTH_ENABLED: 'true' }),
    /SESSION_SECRET/,
  );
  const store = new MemoryStore();
  const app = createApp(undefined, undefined, {
    store,
    ...readConfig(env),
    logger: false,
  });
  try {
    const response = await app.inject('/api/v1/auth/session');
    assert.deepEqual(response.json(), { authenticated: false });
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal((await app.inject('/api/v1/admin/settings')).statusCode, 404);
    assert.equal(store.sessions.size, 0);
  } finally {
    await app.close();
  }
});

test('localhost requires password login and first-login setup even with the retired flag set', async () => {
  const auth = readConfig({
    NODE_ENV: 'development',
    DEV_ADMIN_MODE: 'true',
    AUTH_ENABLED: 'true',
    PUBLIC_ORIGIN: 'http://127.0.0.1:8088',
    SESSION_SECRET: config.secret,
    ADMIN_BOOTSTRAP_PASSWORD: bootstrapPassword,
  }).auth!;
  const store = new MemoryStore();
  store.staff.clear();
  const app = createApp(undefined, undefined, { store, auth, logger: false });
  try {
    const response = await app.inject({
      url: '/api/v1/auth/session',
      headers: { host: '127.0.0.1:8088' },
    });
    assert.deepEqual(response.json(), { authenticated: false });
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(store.sessions.size, 0);
    assert.equal((await app.inject('/api/v1/admin/settings')).statusCode, 401);
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: auth.origin },
      payload: { username: 'admin', password: bootstrapPassword },
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.json().mustChangePassword, true);
    assert.equal(signedIn.json().development, undefined);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/settings', headers: { cookie } }))
        .statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test('a stored session without a staff account cannot authorize admin requests', async () => {
  const { app, store } = fixture();
  const token = 'a'.repeat(43);
  const key = createHmac('sha256', config.secret)
    .update('session:' + token)
    .digest('hex');
  store.sessions.set(key, {
    id: 'local-dev-admin',
    displayName: 'Local test admin',
    accountVersion: 1,
    expiresAt: new Date(Date.now() + 60000),
  });
  const headers = { cookie: '__Host-clog-session=' + token };
  try {
    const response = await app.inject({ url: '/api/v1/auth/session', headers });
    assert.deepEqual(response.json(), { authenticated: false });
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/settings', headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers,
          payload: { hardcoreEnabled: true, expectedRevision: 'settings-1' },
        })
      ).statusCode,
      401,
    );
    assert.deepEqual(store.audits, []);
  } finally {
    await app.close();
  }
});

test('proxy login buckets distinguish clients and ignore spoofed forwarding prefixes', async () => {
  for (const trusted of [['127.0.0.1/32'], ['127.0.0.1/32', '10.20.0.2/32']]) {
    const buckets = new Map<string, number>();
    const store: BackendStore = new MemoryStore();
    store.allowLogin = async (hash) => {
      const count = (buckets.get(hash) ?? 0) + 1;
      buckets.set(hash, count);
      return count <= 20;
    };
    const app = createApp(undefined, undefined, {
      store,
      auth: config,
      trustProxy: trusted,
      logger: false,
    });
    const forward = (client: string) =>
      client + (trusted.length === 2 ? ', 10.20.0.2' : '');
    const attempt = (
      ip: string,
      supplied = password,
      remoteAddress = '127.0.0.1',
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress,
        headers: { origin: config.origin, 'x-forwarded-for': ip },
        payload: { username: 'admin', password: supplied },
      });
    try {
      for (let i = 0; i < 20; i++)
        assert.equal(
          (await attempt(forward('198.51.100.1'), 'wrong')).statusCode,
          401,
        );
      assert.equal(
        (await attempt(forward('203.0.113.99, 198.51.100.1'))).statusCode,
        429,
      );
      assert.equal((await attempt(forward('198.51.100.2'))).statusCode, 200);
      assert.equal(buckets.size, 2);
      // An untrusted direct peer cannot select a different client's bucket.
      assert.equal(
        (await attempt('198.51.100.1', password, '192.0.2.10')).statusCode,
        200,
      );
      assert.equal(buckets.size, 3);
    } finally {
      await app.close();
    }
  }
});

test('explicit admin bootstrap, moderator permissions and self-service credentials are enforced server-side', async () => {
  const store = new MemoryStore();
  store.staff.clear();
  const actors: string[] = [];
  const review = {
    async queue() {
      return {
        revision: 'queue-1',
        submissions: [],
        nextCursor: null,
        pageCursor: 'first',
      };
    },
    async adminCatalog() {
      return { items: [], pages: [] };
    },
    async createManual(_fields: unknown, actor: string) {
      actors.push(actor);
      return { id: 'created' };
    },
    async mutate(
      _id: string,
      _version: number,
      _command: unknown,
      actor: string,
    ) {
      actors.push(actor);
      return { id: 'reviewed' };
    },
  } as unknown as ReviewStore;
  const xp = {
    async history() {
      return { imports: [] };
    },
  } as unknown as XpStore;
  const app = createApp(undefined, undefined, {
    store,
    auth: { ...config, bootstrapPassword },
    review,
    xp,
    logger: false,
  });
  const credentials = async (username: string, supplied: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: config.origin },
      payload: { username, password: supplied },
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      response,
      headers: {
        cookie: String(response.headers['set-cookie']).split(';')[0]!,
        origin: config.origin,
        'x-csrf-token': response.json().csrfToken as string,
      },
    };
  };
  const change = (
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/account',
      headers,
      payload,
    });
  try {
    const first = await credentials('admin', bootstrapPassword);
    assert.equal(first.response.json().mustChangePassword, true);
    assert.deepEqual(await store.accounts(), [
      { id: admin, username: 'admin', role: 'admin', mustChangePassword: true },
    ]);
    for (const url of [
      '/api/v1/admin/settings',
      '/api/v1/admin/accounts',
      '/api/v1/admin/submissions',
      '/api/v1/admin/xp/imports',
    ])
      assert.equal(
        (await app.inject({ url, headers: first.headers })).statusCode,
        403,
        url,
      );
    assert.equal(
      (
        await change(first.headers, {
          currentPassword: bootstrapPassword,
          username: 'owner',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await change(first.headers, {
          currentPassword: 'wrong',
          newPassword: password,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await change(
          { cookie: first.headers.cookie },
          { currentPassword: bootstrapPassword, newPassword: password },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await change(first.headers, {
          currentPassword: bootstrapPassword,
          newPassword: 'short',
        })
      ).statusCode,
      400,
    );
    const saved = await change(first.headers, {
      currentPassword: bootstrapPassword,
      newPassword: password,
      username: 'owner',
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().mustChangePassword, false);
    assert.equal(saved.json().username, 'owner');
    const owner = {
      cookie: String(saved.headers['set-cookie']).split(';')[0]!,
      origin: config.origin,
      'x-csrf-token': saved.json().csrfToken as string,
    };
    assert.notEqual(owner.cookie, first.headers.cookie);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: first.headers,
        })
      ).json().authenticated,
      false,
    );
    const create = (payload: Record<string, unknown>, headers = owner) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers,
        payload,
      });
    assert.equal(
      (await create({ username: 'moderator', password, role: 'admin' }))
        .statusCode,
      400,
    );
    const created = await create({ username: 'moderator', password });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().role, 'moderator');
    assert.equal(created.json().mustChangePassword, true);
    assert.equal(created.body.includes('passwordHash'), false);
    assert.equal(created.body.includes(password), false);
    assert.equal(
      (await create({ username: 'MODERATOR', password })).statusCode,
      409,
    );
    const listed = await app.inject({
      url: '/api/v1/admin/accounts',
      headers: owner,
    });
    assert.equal(listed.json().accounts.length, 2);
    assert.equal(listed.body.includes('passwordHash'), false);
    const mod = await credentials('MODERATOR', password);
    assert.equal(mod.response.json().role, 'moderator');
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/submissions',
          headers: mod.headers,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await change(mod.headers, {
          currentPassword: password,
          newPassword: password,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await change(mod.headers, {
          currentPassword: password,
          newPassword: 'new-moderator-password',
          username: 'OWNER',
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await store.accountByUsername('moderator'))?.mustChangePassword,
      true,
    );
    const modSaved = await change(mod.headers, {
      currentPassword: password,
      newPassword: 'new-moderator-password',
    });
    assert.equal(modSaved.statusCode, 200, modSaved.body);
    const moderator = {
      cookie: String(modSaved.headers['set-cookie']).split(';')[0]!,
      origin: config.origin,
      'x-csrf-token': modSaved.json().csrfToken as string,
    };
    for (const url of ['/api/v1/admin/submissions', '/api/v1/admin/catalog'])
      assert.equal(
        (await app.inject({ url, headers: moderator })).statusCode,
        200,
        url,
      );
    for (const url of [
      '/api/v1/admin/settings',
      '/api/v1/admin/accounts',
      '/api/v1/admin/xp/imports',
    ])
      assert.equal(
        (await app.inject({ url, headers: moderator })).statusCode,
        403,
        url,
      );
    assert.equal(
      (await create({ username: 'another', password }, moderator)).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/settings',
          headers: moderator,
          payload: { hardcoreEnabled: true, expectedRevision: 'settings-1' },
        })
      ).statusCode,
      403,
    );
    const submission = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/submissions',
      headers: { ...moderator, 'idempotency-key': randomUUID() },
      payload: {
        itemId: 42,
        collectorName: 'Collector',
        collectedOn: '2026-10-01',
        hardcore: false,
        approve: false,
      },
    });
    assert.equal(submission.statusCode, 201, submission.body);
    const decision = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/submissions/00000000-0000-4000-8000-000000000099/approve',
      headers: moderator,
      payload: { expectedVersion: 1 },
    });
    assert.equal(decision.statusCode, 200, decision.body);
    assert.deepEqual(actors, [created.json().id, created.json().id]);
    // A username-only edit also rotates sessions and preserves the password/role.
    const second = await credentials('moderator', 'new-moderator-password');
    const renamed = await change(moderator, {
      currentPassword: 'new-moderator-password',
      username: 'reviewer',
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().role, 'moderator');
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: second.headers,
        })
      ).json().authenticated,
      false,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: config.origin },
          payload: {
            username: 'moderator',
            password: 'new-moderator-password',
          },
        })
      ).statusCode,
      401,
    );
    await credentials('reviewer', 'new-moderator-password');
    // Late session creation from an older credential snapshot fails closed.
    const staleAccount = await store.accountByUsername('reviewer');
    await store.updateAccount(
      staleAccount!.id,
      staleAccount!.credentialVersion,
      'reviewer',
      await hashPassword('yet-another-password'),
    );
    for (const session of store.sessions.values())
      if (session.id === staleAccount!.id)
        assert.fail('Credential changes must revoke all sessions.');
    const restarted = createApp(undefined, undefined, {
      store,
      auth: config,
      logger: false,
    });
    await restarted.ready();
    assert.equal(
      (await store.accounts()).filter((account) => account.role === 'admin')
        .length,
      1,
    );
    assert.equal(await store.accountByUsername('admin'), null);
    assert.equal(
      (await store.accountByUsername('owner'))?.mustChangePassword,
      false,
    );
    await restarted.close();
  } finally {
    await app.close();
  }
});

/** Individual staff accounts, expiring sessions, roles and same-origin CSRF. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthConfig } from './config.js';
import { xpAdminRoutes } from './xp-routes.js';
import { reviewRoutes } from './review-routes.js';
import type { ReviewStore } from './review-types.js';
import type { XpStore } from './xp-types.js';
import { fetchWomCompetition } from './wom.js';
import { ApiError, type BackendStore } from './types.js';
import type { ClanKeyStore, ClanKeyUpdate } from './clan-api-key.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  defaultSiteCopy,
  type SiteCopy,
  type HardcoreAppearance,
} from '@clog/domain';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookieValue(request: FastifyRequest, name: string) {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + '='));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(name.length + 1);
  return /^[\w-]{43}$/u.test(value) ? value : undefined;
}
export function authRoutes(
  app: FastifyInstance,
  store: BackendStore,
  config: AuthConfig,
  xp?: XpStore,
  review?: ReviewStore,
  fetchWom: typeof fetchWomCompetition = fetchWomCompetition,
  clanKeys?: ClanKeyStore,
) {
  let dummyHash: string;
  app.addHook('onReady', async () => {
    dummyHash = await hashPassword('admin');
    await store.ensureDefaultAdmin(dummyHash);
  });
  const sessionName = config.secure ? '__Host-clog-session' : 'clog-session';
  const cookie = (value: string, seconds: number) =>
    `${sessionName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
  const key = (token: string) =>
    createHmac('sha256', config.secret)
      .update('session:' + token)
      .digest('hex');
  const csrf = (token: string) =>
    createHmac('sha256', config.secret)
      .update('csrf:' + token)
      .digest('base64url');
  async function current(request: FastifyRequest) {
    const token = cookieValue(request, sessionName);
    if (!token) return null;
    const session = await store.session(key(token));
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    const account = await store.accountById(session.id);
    if (
      !account ||
      account.disabled ||
      account.credentialVersion !== session.accountVersion
    )
      return null;
    return {
      token,
      ...session,
      displayName: account.username,
      role: account.role,
      mustChangePassword: account.mustChangePassword,
    };
  }
  async function requireAdmin(
    request: FastifyRequest,
    write = false,
    allowSetup = false,
  ) {
    const session = await current(request);
    if (!session)
      throw new ApiError(401, 'Sign in with your staff account to continue.');
    if (write) {
      const supplied = request.headers['x-csrf-token'];
      if (
        request.headers.origin !== config.origin ||
        typeof supplied !== 'string' ||
        !/^[\w-]{43}$/u.test(supplied) ||
        !same(csrf(session.token), supplied)
      )
        throw new ApiError(
          403,
          'The request could not be verified. Reload and try again.',
        );
    }
    if (session.mustChangePassword && !allowSetup)
      throw new ApiError(403, 'Change your password before using staff tools.');
    return session;
  }
  async function requireOwner(request: FastifyRequest, write = false) {
    const session = await requireAdmin(request, write);
    if (session.role !== 'admin')
      throw new ApiError(403, 'Only the administrator can use this tool.');
    return session;
  }
  const receipt = (session: {
    token: string;
    displayName: string;
    role: 'admin' | 'moderator';
    mustChangePassword: boolean;
  }) => ({
    authenticated: true,
    displayName: session.displayName,
    username: session.displayName,
    role: session.role,
    mustChangePassword: session.mustChangePassword,
    csrfToken: csrf(session.token),
  });
  async function signIn(account: {
    id: string;
    username: string;
    credentialVersion: number;
  }) {
    const token = nonce();
    await store.createSession(
      key(token),
      {
        id: account.id,
        displayName: account.username,
        accountVersion: account.credentialVersion,
      },
      new Date(Date.now() + 8 * 60 * 60 * 1000),
    );
    return token;
  }
  if (xp) xpAdminRoutes(app, xp, requireOwner, fetchWom);
  if (review) reviewRoutes(app, review, requireAdmin);
  app.post<{ Body: { username: string; password: string } }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 32 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
      onRequest: async (request) => {
        if (request.headers.origin !== config.origin)
          throw new ApiError(
            403,
            'Login must originate from the configured site.',
          );
      },
    },
    async (request, reply) => {
      // Shared database limiter applies to *all* attempts, not just invalid ones.
      if (!(await store.allowLogin(hash(request.ip))))
        throw new ApiError(
          429,
          'Too many sign-in attempts. Try again in a minute.',
        );
      const account = await store.accountByUsername(request.body.username);
      const valid = await verifyPassword(
        request.body.password,
        account && !account.disabled ? account.passwordHash : dummyHash,
      );
      if (!account || account.disabled || !valid)
        throw new ApiError(401, 'Incorrect username or password.');
      const old = cookieValue(request, sessionName);
      if (old) await store.deleteSession(key(old));
      const token = await signIn(account);
      return reply.header('Set-Cookie', cookie(token, 8 * 60 * 60)).send(
        receipt({
          token,
          displayName: account.username,
          role: account.role,
          mustChangePassword: account.mustChangePassword,
        }),
      );
    },
  );
  app.get('/api/v1/auth/session', async (request) => {
    const session = await current(request);
    return session ? receipt(session) : { authenticated: false };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await requireAdmin(request, true, true);
    await store.deleteSession(key(session.token));
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  });
  const usernameField = {
    type: 'string',
    pattern: '^[A-Za-z0-9_.-]{3,32}$',
    maxLength: 32,
  };
  const passwordField = { type: 'string', minLength: 12, maxLength: 256 };
  app.patch<{
    Body: { username?: string; currentPassword: string; newPassword?: string };
  }>(
    '/api/v1/auth/account',
    {
      onRequest: async (request) => {
        await requireAdmin(request, true, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword'],
          anyOf: [{ required: ['username'] }, { required: ['newPassword'] }],
          properties: {
            username: usernameField,
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: passwordField,
          },
        },
      },
    },
    async (request, reply) => {
      const session = await requireAdmin(request, true, true);
      if (!(await store.allowLogin(hash('account:' + session.id))))
        throw new ApiError(
          429,
          'Too many password attempts. Try again in a minute.',
        );
      const account = await store.accountById(session.id);
      if (!account || account.credentialVersion !== session.accountVersion)
        throw new ApiError(401, 'Sign in again before changing your account.');
      if (
        !(await verifyPassword(
          request.body.currentPassword,
          account.passwordHash,
        ))
      )
        throw new ApiError(400, 'The current password is incorrect.');
      const { newPassword } = request.body;
      if (account.mustChangePassword && !newPassword)
        throw new ApiError(
          400,
          'Choose a new password to finish account setup.',
        );
      if (
        newPassword &&
        (await verifyPassword(newPassword, account.passwordHash))
      )
        throw new ApiError(
          400,
          'Choose a password different from your current password.',
        );
      const saved = await store.updateAccount(
        account.id,
        account.credentialVersion,
        request.body.username ?? account.username,
        newPassword ? await hashPassword(newPassword) : undefined,
      );
      const token = await signIn(saved);
      return reply.header('Set-Cookie', cookie(token, 8 * 60 * 60)).send(
        receipt({
          token,
          displayName: saved.username,
          role: saved.role,
          mustChangePassword: saved.mustChangePassword,
        }),
      );
    },
  );
  app.get('/api/v1/admin/accounts', async (request) => {
    await requireOwner(request);
    return { accounts: await store.accounts() };
  });
  app.post<{ Body: { username: string; password: string } }>(
    '/api/v1/admin/accounts',
    {
      onRequest: async (request) => {
        await requireOwner(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: { username: usernameField, password: passwordField },
        },
      },
    },
    async (request, reply) => {
      const session = await requireOwner(request, true);
      const saved = await store.createModerator(
        request.body.username,
        await hashPassword(request.body.password),
        session.id,
      );
      return reply.code(201).send(saved);
    },
  );
  for (const action of ['disable', 'enable', 'delete'] as const)
    app.post<{
      Params: { id: string };
      Body: { expectedVersion: number };
    }>(
      `/api/v1/admin/accounts/:id/${action}`,
      {
        onRequest: async (request) => {
          await requireOwner(request, true);
        },
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            required: ['expectedVersion'],
            additionalProperties: false,
            properties: {
              expectedVersion: {
                type: 'integer',
                minimum: 1,
                maximum: 2147483647,
              },
            },
          },
        },
      },
      async (request) => {
        const actor = await requireOwner(request, true);
        if (!store.manageModerator)
          throw new ApiError(503, 'Account management unavailable.');
        return store.manageModerator(
          request.params.id,
          request.body.expectedVersion,
          action,
          actor.id,
        );
      },
    );
  app.get('/api/v1/admin/settings', async (request) => {
    await requireOwner(request);
    return store.settings();
  });
  const copySchema = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(defaultSiteCopy),
    properties: Object.fromEntries(
      Object.keys(defaultSiteCopy).map((key) => [
        key,
        {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          pattern: '^[^\\u0000-\\u001f\\u007f]*\\S[^\\u0000-\\u001f\\u007f]*$',
        },
      ]),
    ),
  };
  app.put<{
    Body: {
      hardcoreEnabled: boolean;
      expectedRevision: string;
      clanName?: string;
      copy?: SiteCopy;
      hardcore?: HardcoreAppearance;
    };
  }>(
    '/api/v1/admin/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['hardcoreEnabled', 'expectedRevision'],
          properties: {
            hardcoreEnabled: { type: 'boolean' },
            copy: copySchema,
            hardcore: {
              type: 'object',
              additionalProperties: false,
              required: ['clanName', 'copy'],
              properties: {
                clanName: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 80,
                  pattern:
                    '^[^\\u0000-\\u001f\\u007f]*\\S[^\\u0000-\\u001f\\u007f]*$',
                },
                copy: copySchema,
              },
            },
            clanName: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              pattern: '\\S',
            },
            expectedRevision: {
              type: 'string',
              pattern: '^settings-[1-9][0-9]*$',
              maxLength: 30,
            },
          },
        },
      },
      // Authenticate before schema validation to avoid exposing private request behavior.
      onRequest: async (request) => {
        await requireOwner(request, true);
      },
    },
    async (request) => {
      const session = await requireOwner(request, true);
      const saved = await store.saveSettings(
        request.body.hardcoreEnabled,
        request.body.expectedRevision,
        session.id,
        request.body.clanName,
        request.body.copy,
        request.body.hardcore,
      );
      if (!saved)
        throw new ApiError(
          409,
          'Settings changed. Reload before saving again.',
        );
      return saved;
    },
  );
  app.get('/api/v1/admin/clan-api-key', async (request) => {
    await requireOwner(request);
    if (!clanKeys)
      throw new ApiError(503, 'Clan API key storage is unavailable.');
    return clanKeys.settings();
  });
  app.put<{ Body: ClanKeyUpdate }>(
    '/api/v1/admin/clan-api-key',
    {
      onRequest: async (request) => {
        await requireOwner(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision'],
          properties: {
            expectedRevision: {
              type: 'string',
              pattern: '^clan-key-[1-9][0-9]*$',
              maxLength: 30,
            },
            enabled: { type: 'boolean' },
            key: { type: 'string' },
            generate: { const: true },
          },
        },
      },
    },
    async (request) => {
      const actor = await requireOwner(request, true);
      if (!clanKeys)
        throw new ApiError(503, 'Clan API key storage is unavailable.');
      return clanKeys.update(request.body, actor.id);
    },
  );
  return requireAdmin;
}

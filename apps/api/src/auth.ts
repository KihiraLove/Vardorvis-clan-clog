/** Shared-password login, expiring sessions and same-origin CSRF for admin routes. */
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
) {
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
  function requireLocalHost(request: FastifyRequest) {
    if (!config.devOnly) return;
    const host = request.headers.host ?? '';
    if (
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/iu.test(host) ||
      request.headers['x-forwarded-host'] !== undefined
    )
      throw new ApiError(
        403,
        'Local admin mode accepts only loopback hostnames.',
      );
  }
  async function current(request: FastifyRequest) {
    requireLocalHost(request);
    const token = cookieValue(request, sessionName);
    if (!token) return null;
    const session = await store.session(key(token));
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    if (session.id !== (config.devOnly ? 'local-dev-admin' : 'password-admin'))
      return null;
    return { token, ...session };
  }
  async function requireAdmin(request: FastifyRequest, write = false) {
    const session = await current(request);
    if (!session)
      throw new ApiError(401, 'Enter the admin password to continue.');
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
    return session;
  }
  if (xp) xpAdminRoutes(app, xp, requireAdmin, fetchWom);
  if (review) reviewRoutes(app, review, requireAdmin);
  app.post<{ Body: { password: string } }>(
    '/api/v1/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
      onRequest: async (request) => {
        if (config.devOnly)
          throw new ApiError(
            404,
            'Password login is disabled for local test mode.',
          );
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
      const digest = createHmac('sha256', Buffer.from(config.secret, 'hex'))
        .update('admin-password:')
        .update(request.body.password)
        .digest();
      if (
        !config.passwordDigest ||
        !timingSafeEqual(digest, config.passwordDigest)
      )
        throw new ApiError(401, 'Incorrect admin password.');
      const old = cookieValue(request, sessionName);
      if (old) await store.deleteSession(key(old));
      const token = nonce();
      await store.createSession(
        key(token),
        { id: 'password-admin', displayName: 'Clan admin' },
        new Date(Date.now() + 8 * 60 * 60 * 1000),
      );
      return reply.header('Set-Cookie', cookie(token, 8 * 60 * 60)).send({
        authenticated: true,
        displayName: 'Clan admin',
        csrfToken: csrf(token),
      });
    },
  );
  app.get('/api/v1/auth/session', async (request, reply) => {
    let session = await current(request);
    if (!session && config.devOnly) {
      const token = nonce();
      const identity = {
        id: 'local-dev-admin',
        displayName: 'Local test admin',
      };
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      await store.createSession(key(token), identity, expiresAt);
      reply.header('Set-Cookie', cookie(token, 8 * 60 * 60));
      session = { ...identity, token, expiresAt };
    }
    return session
      ? {
          authenticated: true,
          displayName: session.displayName,
          csrfToken: csrf(session.token),
          ...(config.devOnly ? { development: true } : {}),
        }
      : { authenticated: false };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await requireAdmin(request, true);
    await store.deleteSession(key(session.token));
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  });
  app.get('/api/v1/admin/settings', async (request) => {
    await requireAdmin(request);
    return store.settings();
  });
  app.put<{ Body: { hardcoreEnabled: boolean; expectedRevision: string } }>(
    '/api/v1/admin/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['hardcoreEnabled', 'expectedRevision'],
          properties: {
            hardcoreEnabled: { type: 'boolean' },
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
        await requireAdmin(request, true);
      },
    },
    async (request) => {
      const session = await requireAdmin(request, true);
      const saved = await store.saveSettings(
        request.body.hardcoreEnabled,
        request.body.expectedRevision,
        session.id,
      );
      if (!saved)
        throw new ApiError(
          409,
          'Settings changed. Reload before saving again.',
        );
      return saved;
    },
  );
  return requireAdmin;
}

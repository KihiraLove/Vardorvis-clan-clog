/** OAuth state binding, server sessions and same-origin CSRF checks for private routes. */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthConfig } from './config.js';
import type { Identify } from './discord.js';
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
  identify: Identify,
) {
  const sessionName = config.secure ? '__Host-clog-session' : 'clog-session';
  const stateName = config.secure ? '__Host-clog-oauth' : 'clog-oauth';
  const cookie = (name: string, value: string, seconds: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? '; Secure' : ''}`;
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
    if (!config.adminIds.has(session.id))
      throw new ApiError(
        403,
        'Your account is not allowed to administer the clan.',
      );
    return { token, ...session };
  }
  async function requireAdmin(request: FastifyRequest, write = false) {
    const session = await current(request);
    if (!session) throw new ApiError(401, 'Sign in to administer the clan.');
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
  async function loginLimit(request: FastifyRequest) {
    if (!(await store.allowLogin(hash(request.ip))))
      throw new ApiError(
        429,
        'Too many sign-in attempts. Try again in a minute.',
      );
  }
  app.get('/api/v1/auth/discord', async (request, reply) => {
    await loginLimit(request);
    const state = nonce();
    await store.createState(hash(state), new Date(Date.now() + 10 * 60 * 1000));
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      scope: 'identify',
      redirect_uri: config.redirectUri,
      state,
    }).toString();
    return reply
      .header('Set-Cookie', cookie(stateName, state, 600))
      .redirect(url.toString());
  });
  app.get('/api/v1/auth/discord/callback', async (request, reply) => {
    await loginLimit(request);
    reply.header('Set-Cookie', cookie(stateName, '', 0));
    const query = request.query as Record<string, unknown>,
      state = query.state,
      code = query.code;
    const browser = cookieValue(request, stateName);
    if (
      typeof state !== 'string' ||
      !/^[\w-]{43}$/u.test(state) ||
      !browser ||
      !same(browser, state) ||
      !(await store.consumeState(hash(state)))
    )
      throw new ApiError(
        400,
        'Sign-in expired or could not be verified. Start again.',
      );
    if (
      typeof code !== 'string' ||
      !code ||
      code.length > 2048 ||
      query.error !== undefined
    )
      throw new ApiError(400, 'Discord sign-in was not completed.');
    const identity = await identify(code);
    if (!config.adminIds.has(identity.id))
      throw new ApiError(
        403,
        'Your account is not allowed to administer the clan.',
      );
    const old = cookieValue(request, sessionName);
    if (old) await store.deleteSession(key(old));
    const token = nonce();
    await store.createSession(
      key(token),
      identity,
      new Date(Date.now() + 8 * 60 * 60 * 1000),
    );
    // Rotate on every successful sign-in and always return to the configured admin page.
    return reply
      .header('Set-Cookie', [
        cookie(stateName, '', 0),
        cookie(sessionName, token, 8 * 60 * 60),
      ])
      .redirect(config.origin + '/admin');
  });
  app.get('/api/v1/auth/session', async (request) => {
    const session = await current(request);
    return session
      ? {
          authenticated: true,
          displayName: session.displayName,
          csrfToken: csrf(session.token),
        }
      : { authenticated: false };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await requireAdmin(request, true);
    await store.deleteSession(key(session.token));
    return reply
      .header('Set-Cookie', cookie(sessionName, '', 0))
      .code(204)
      .send();
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
}

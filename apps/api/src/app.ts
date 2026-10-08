/** Public projections plus optional configured Discord auth; unavailable services fail closed. */
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { catalogRoutes } from './catalog-routes.js';
import type { PgCatalogStore } from './catalog-store.js';
import type { IconStorage } from './icon-storage.js';
import type { AuthConfig } from './config.js';
import { authRoutes } from './auth.js';
import { discordIdentify, type Identify } from './discord.js';
import { ApiError, type BackendStore, type Settings } from './types.js';
interface Options {
  catalog?: PgCatalogStore | undefined;
  icons?: IconStorage | undefined;
  store?: BackendStore | undefined;
  auth?: AuthConfig | undefined;
  identify?: Identify;
  trustProxy?: false | string[];
  logger?: boolean;
}
export function createApp(
  checkDatabase: () => Promise<void> = async () => {
    throw new Error('Database not configured');
  },
  readSettings: () => Promise<Settings> = async () => ({
    revision: 'settings-disabled',
    hardcoreEnabled: false,
  }),
  options: Options = {},
) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    requestTimeout: 15000,
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
            ],
            // OAuth code/state are in the query string; never use Fastify's default URL serializer.
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                path: req.url.split('?')[0],
              }),
            },
          },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (
      request.url.startsWith('/api/v1/auth/') ||
      request.url.startsWith('/api/v1/admin/')
    )
      reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof Error && 'validation' in error
          ? 400
          : error instanceof Error &&
              'statusCode' in error &&
              typeof error.statusCode === 'number' &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? error.statusCode
            : 503;
    // Do not log driver/provider errors: they may contain SQL parameters or OAuth secrets.
    if (status >= 500)
      request.log.error(
        { status, path: request.url.split('?')[0] },
        'API operation failed',
      );
    if (status === 429) reply.header('Retry-After', '60');
    return reply.code(status).send({
      error:
        error instanceof ApiError
          ? error.message
          : status === 400
            ? 'Invalid request fields.'
            : status === 413
              ? 'Request is too large.'
              : 'Service temporarily unavailable.',
    });
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: 'Not found.' }),
  );
  app.get('/healthz', async () => ({ status: 'ok', service: 'api' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/api/v1/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readSettings();
  });
  const store = options.store;
  for (const resource of ['catalog', 'collections'] as const) {
    app.get('/api/v1/' + resource, async (request, reply) => {
      if (!store)
        throw new ApiError(503, 'The catalog service is not configured.');
      const data =
        resource === 'catalog'
          ? await store.catalog()
          : { credits: await store.collections() };
      const revision =
        resource +
        '-' +
        createHash('sha256').update(JSON.stringify(data)).digest('hex');
      const etag = '"' + revision + '"';
      reply
        .header('ETag', etag)
        .header('Cache-Control', 'public, max-age=0, must-revalidate');
      const candidates = (request.headers['if-none-match'] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^W\//u, ''));
      if (candidates.includes(etag) || candidates.includes('*'))
        return reply.code(304).send();
      return { revision, ...data };
    });
  }
  app.get('/api/v1/status', async () => {
    let catalogReady = false;
    if (store)
      try {
        await store.catalog();
        catalogReady = true;
      } catch {
        /* An empty/unavailable catalog is not release-ready. */
      }
    return {
      stage: store ? 'backend' : 'foundation',
      catalogReady,
      submissionsEnabled: false,
      adminAuthEnabled: !!(store && options.auth),
    };
  });
  const requireAdmin =
    store && options.auth
      ? authRoutes(
          app,
          store,
          options.auth,
          options.identify ?? discordIdentify(options.auth),
        )
      : undefined;
  if (!requireAdmin) {
    app.get('/api/v1/auth/session', async () => ({ authenticated: false }));
    app.get('/api/v1/auth/discord', async () => {
      throw new ApiError(503, 'Admin sign-in is not configured.');
    });
  }
  if (options.catalog && options.icons)
    catalogRoutes(app, options.catalog, options.icons, requireAdmin);
  app.get<{ Querystring: { q?: string } }>(
    '/api/v1/catalog/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 100 } },
        },
      },
    },
    async (request) => {
      if (!store) throw new ApiError(503, 'Catalog search unavailable.');
      const data = await store.catalog(),
        query = (request.query.q ?? '').trim().toLowerCase();
      return {
        revision:
          'catalog-' +
          createHash('sha256').update(JSON.stringify(data)).digest('hex'),
        items: data.items
          .filter(
            (item) =>
              item.name.toLowerCase().includes(query) ||
              String(item.id) === query,
          )
          .slice(0, 25),
      };
    },
  );
  return app;
}

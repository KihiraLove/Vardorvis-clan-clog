/** Public projections plus optional configured admin auth; unavailable services fail closed. */
import { proofRoutes } from './proof-routes.js';
import { runeLiteSettingsRoutes } from './runelite-settings-routes.js';
import { schedulingRoutes } from './scheduling-routes.js';
import { competitionRoutes } from './competition-routes.js';
import { lifecycleRoutes } from './lifecycle-routes.js';
import { brandingRoutes } from './branding-routes.js';
import type { BrandingStorage } from './branding-storage.js';
import type { BrandingStore } from './branding-store.js';
import type { ProofStorage } from './proof-storage.js';
import type { ProofStore } from './proof-store.js';
import { checkReadiness } from './readiness.js';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { catalogRoutes } from './catalog-routes.js';
import type { PgCatalogStore } from './catalog-store.js';
import type { IconStorage } from './icon-storage.js';
import type { AuthConfig, BotConfig } from './config.js';
import { botRoutes } from './intake.js';
import { authRoutes } from './auth.js';
import { xpPublicRoutes } from './xp-routes.js';
import type { ReviewStore } from './review-types.js';
import { fetchWomCompetition } from './wom.js';
import { PreviewWork } from './preview-work.js';
import { PasswordHasher } from './passwords.js';
import { WorkloadError } from '@clog/domain';
import { matchesEtag } from './projection-cache.js';
import type { XpStore } from './xp-types.js';
import { ApiError, type BackendStore, type Settings } from './types.js';
interface Options {
  passwords?: PasswordHasher;
  previews?: PreviewWork;
  lifecycle?:
    import('@clog/database/dist/lifecycle.js').PgLifecycleStore | undefined;
  competitions?:
    import('./competition-store.js').PgCompetitionStore | undefined;
  fetchCompetition?: typeof import('./competition-wom.js').fetchCompetition;
  scheduling?: import('./scheduling-store.js').SchedulingStore | undefined;
  runeLiteSettings?:
    import('./runelite-settings.js').RuneLiteSettingsStore | undefined;
  branding?: BrandingStore | undefined;
  logos?: BrandingStorage | undefined;
  clanKeys?: import('./clan-api-key.js').ClanKeyStore | undefined;
  proofs?: ProofStorage | undefined;
  proofStore?: ProofStore | undefined;
  checkBotReady?: (() => Promise<void>) | undefined;
  catalog?: PgCatalogStore | undefined;
  icons?: IconStorage | undefined;
  store?: BackendStore | undefined;
  auth?: AuthConfig | undefined;
  bot?: BotConfig | undefined;
  xp?: XpStore | undefined;
  review?: ReviewStore | undefined;
  fetchWom?: typeof fetchWomCompetition;
  trustProxy?: false | string[];
  logger?: boolean;
}
export function createApp(
  checkDatabase: () => Promise<void> = async () => {
    throw new Error('Database not configured');
  },
  readSettings: () => Promise<Settings> = async () => ({
    revision: 'settings-disabled',
    clanName: 'Clan name',
    hardcoreEnabled: false,
  }),
  options: Options = {},
) {
  const previews = options.previews ?? new PreviewWork();
  const passwords = options.passwords ?? new PasswordHasher();
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
              'req.headers["x-clan-api-key"]',
              'req.headers["x-clan-api-key-base64"]',
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
  app.addHook('onClose', async () => {
    previews.budget.close();
    await passwords.close();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (
      request.url.startsWith('/api/v1/auth/') ||
      request.url.startsWith('/api/v1/admin/') ||
      request.url.startsWith('/api/v1/bot/') ||
      request.url.startsWith('/api/v1/runelite/')
    )
      reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof WorkloadError
        ? 429
        : error instanceof ApiError
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
    if (status === 429)
      reply.header(
        'Retry-After',
        String(
          error instanceof WorkloadError || error instanceof ApiError
            ? (error.retryAfterSeconds ?? 60)
            : 60,
        ),
      );
    return reply.code(status).send({
      error:
        error instanceof ApiError || error instanceof WorkloadError
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
      await checkReadiness(checkDatabase, options.checkBotReady);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/api/v1/settings', async (request, reply) => {
    const value = await readSettings(),
      etag = '"' + value.revision + '"';
    reply
      .header('Cache-Control', 'public, max-age=0, must-revalidate')
      .header('ETag', etag);
    if (matchesEtag(request.headers['if-none-match'], etag))
      return reply.code(304).send();
    return value;
  });
  const store = options.store;
  if (options.xp) xpPublicRoutes(app, options.xp);
  for (const resource of ['catalog', 'collections'] as const) {
    app.get('/api/v1/' + resource, async (request, reply) => {
      if (!store)
        throw new ApiError(503, 'The catalog service is not configured.');
      if (store.publicSnapshot) {
        const snapshot = await store.publicSnapshot(resource),
          etag = '"' + snapshot.revision + '"';
        reply
          .header('ETag', etag)
          .header('Cache-Control', 'public, max-age=0, must-revalidate');
        if (matchesEtag(request.headers['if-none-match'], etag))
          return reply.code(304).send();
        return reply.type('application/json').send(snapshot.body);
      }
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
      submissionsEnabled: !!(store && options.bot),
      runeliteSubmissionsEnabled: !!(options.proofs && options.proofStore),
      adminAuthEnabled: !!(store && options.auth),
    };
  });
  if (store && options.bot) botRoutes(app, store, options.bot);
  const requireAdmin =
    store && options.auth
      ? authRoutes(
          app,
          store,
          options.auth,
          options.xp,
          options.review,
          options.fetchWom ?? fetchWomCompetition,
          options.clanKeys,
          previews,
          passwords,
        )
      : undefined;
  if (!requireAdmin) {
    app.get('/api/v1/auth/session', async () => ({ authenticated: false }));
    app.post('/api/v1/auth/login', async () => {
      throw new ApiError(503, 'Admin password sign-in is not configured.');
    });
  }
  brandingRoutes(app, options.branding, options.logos, requireAdmin);
  runeLiteSettingsRoutes(app, options.runeLiteSettings, requireAdmin);
  schedulingRoutes(app, options.scheduling, requireAdmin);
  lifecycleRoutes(app, options.lifecycle, requireAdmin);
  competitionRoutes(
    app,
    options.competitions,
    requireAdmin,
    options.fetchCompetition,
    previews,
  );
  // Review and catalog editing share one private catalog projection and auth boundary.
  if (options.catalog || options.review)
    app.get(
      '/api/v1/admin/catalog',
      {
        onRequest: async (request) => {
          if (!requireAdmin)
            throw new ApiError(503, 'Admin sign-in is not configured.');
          await requireAdmin(request);
        },
      },
      () =>
        options.catalog
          ? options.catalog.catalog()
          : options.review!.adminCatalog(),
    );
  if (options.proofs && options.proofStore)
    proofRoutes(
      app,
      options.proofStore,
      options.proofs,
      options.review,
      requireAdmin,
    );
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

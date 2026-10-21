/** Public projections plus optional configured admin auth; unavailable services fail closed. */
import { proofRoutes } from './proof-routes.js';
import { discordSettingsRoutes } from './discord-settings-routes.js';
import { runeLiteSettingsRoutes } from './runelite-settings-routes.js';
import { schedulingRoutes } from './scheduling-routes.js';
import { competitionRoutes } from './competition-routes.js';
import { lifecycleRoutes } from './lifecycle-routes.js';
import { brandingRoutes } from './branding-routes.js';
import type { BrandingStore } from './branding-store.js';
import type { ProofStore } from './proof-store.js';
import { checkReadiness } from './readiness.js';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { catalogRoutes } from './catalog-routes.js';
import {
  catalogUpdateRoutes,
  type CatalogUpdateService,
} from './catalog-update-routes.js';
import type {
  ApplicationStore,
  CatalogService,
  CompetitionService,
  LifecycleReader,
  IconFiles,
  ProofFiles,
  BrandingFiles,
} from './route-services.js';
import type { AuthConfig, BotConfig } from './config.js';
import { botRoutes } from './intake.js';
import { authRoutes } from './auth.js';
import { xpPublicRoutes } from './xp-routes.js';
import type { ReviewStore } from './review-types.js';
import { fetchWomCompetition } from './wom.js';
import { PreviewWork } from './preview-work.js';
import { PasswordHasher } from './passwords.js';
import {
  WorkloadError,
  WorkDrain,
  OperationalDiagnostics,
  safeFailure,
} from '@clog/domain';
import { trackHttpWork } from './runtime-work.js';
import { matchesEtag } from './projection-cache.js';
import type { XpStore } from './xp-types.js';
import { ApiError, type Settings } from './types.js';
interface Options {
  accessControl?: import('./access-control.js').AccessControlStore | undefined;
  discordSettings?:
    | import('@clog/database/dist/discord-settings.js').DiscordSettingsStore
    | undefined;
  registerDiscord?: typeof import('@clog/bot/dist/register.js').registerWithCredentials;
  botConfiguration?: (() => Promise<BotConfig | undefined>) | undefined;
  work?: WorkDrain;
  diagnostics?: OperationalDiagnostics;
  poolMetrics?: () => { total: number; idle: number; waiting: number };
  passwords?: PasswordHasher;
  previews?: PreviewWork;
  lifecycle?: LifecycleReader | undefined;
  competitions?: CompetitionService | undefined;
  fetchCompetition?: typeof import('./competition-wom.js').fetchCompetition;
  scheduling?: import('./scheduling-store.js').SchedulingStore | undefined;
  runeLiteSettings?:
    import('./runelite-settings.js').RuneLiteSettingsStore | undefined;
  branding?: BrandingStore | undefined;
  logos?: BrandingFiles | undefined;
  clanKeys?: import('./clan-api-key.js').ClanKeyStore | undefined;
  proofs?: ProofFiles | undefined;
  proofStore?: ProofStore | undefined;
  readBotConnectionState?:
    | (() => Promise<
        Exclude<import('@clog/domain').DiscordConnectionState, 'disabled'>
      >)
    | undefined;
  catalog?: CatalogService | undefined;
  catalogUpdates?: CatalogUpdateService | undefined;
  icons?: IconFiles | undefined;
  store?: ApplicationStore | undefined;
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
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
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
            // Query strings may contain private data; log operation/correlation only.
            serializers: {
              req: () => ({ operation: 'http' }),
              err: (error: unknown) => ({
                type: 'OperationError',
                message: 'Operation failed',
                stack: '',
                ...safeFailure(error),
              }),
            },
          },
  });
  const work = options.work ?? new WorkDrain();
  const diagnostics =
    options.diagnostics ??
    new OperationalDiagnostics('api', (record) =>
      app.log.info(record, 'Operation'),
    );
  trackHttpWork(app, work, diagnostics);
  app.addHook('onClose', async () => {
    await work.stop();
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
    // Driver/provider errors may contain SQL parameters or credentials.
    const fault = safeFailure(
      error,
      error instanceof ApiError ||
        error instanceof WorkloadError ||
        status < 500
        ? status
        : undefined,
    );
    diagnostics.record('failure', {
      operation: 'http',
      ...fault,
      status,
      correlation: request.id,
    });
    reply.header('X-Error-Category', fault.category);
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
  let wasReady: boolean | undefined;
  app.get('/readyz', async (_request, reply) => {
    try {
      if (work.snapshot().stopping) throw new Error('Draining');
      await checkReadiness(checkDatabase);
      if (wasReady !== true)
        diagnostics.record('readiness', {
          operation: 'readiness',
          code: 'READY',
        });
      wasReady = true;
      return { status: 'ready' };
    } catch {
      if (wasReady !== false)
        diagnostics.record('readiness', {
          operation: 'readiness',
          code: 'NOT_READY',
        });
      wasReady = false;
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/api/v1/discord/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (
      !options.readBotConnectionState ||
      (options.botConfiguration && !(await options.botConfiguration()))
    )
      return { enabled: false, ready: false, state: 'disabled' };
    try {
      const observed: {
        state: Exclude<
          import('@clog/domain').DiscordConnectionState,
          'disabled'
        >;
      } = { state: 'unavailable' };
      await checkReadiness(async () => {
        observed.state = await options.readBotConnectionState!();
      });
      const { state } = observed;
      return reply
        .code(state === 'connected' ? 200 : 503)
        .send({ enabled: true, ready: state === 'connected', state });
    } catch {
      return reply
        .code(503)
        .send({ enabled: true, ready: false, state: 'unavailable' });
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
      submissionsEnabled: !!(
        store &&
        (options.botConfiguration
          ? await options.botConfiguration()
          : options.bot)
      ),
      runeliteSubmissionsEnabled: !!(options.proofs && options.proofStore),
      adminAuthEnabled: !!(store && options.auth),
    };
  });
  if (store && (options.botConfiguration || options.bot))
    botRoutes(
      app,
      store,
      options.botConfiguration ?? options.bot!,
      options.proofs,
    );
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
          options.accessControl,
        )
      : undefined;
  if (!requireAdmin) {
    app.get('/api/v1/auth/session', async () => ({ authenticated: false }));
    app.post('/api/v1/auth/login', async () => {
      throw new ApiError(503, 'Admin password sign-in is not configured.');
    });
  }
  app.get(
    '/api/v1/admin/diagnostics',
    {
      onRequest: async (request) => {
        if (!requireAdmin)
          throw new ApiError(503, 'Admin sign-in is not configured.');
        const identity = await requireAdmin(request);
        if (identity.role !== 'admin')
          throw new ApiError(
            403,
            'Only the administrator can read diagnostics.',
          );
      },
    },
    async () => ({
      counters: diagnostics.snapshot(),
      work: {
        active: work.snapshot().active,
        stopping: work.snapshot().stopping,
      },
      queues: {
        passwords: passwords.snapshot(),
        previews: previews.budget.snapshot(),
        pool: options.poolMetrics?.() ?? null,
      },
    }),
  );
  brandingRoutes(app, options.branding, options.logos, requireAdmin);
  runeLiteSettingsRoutes(app, options.runeLiteSettings, requireAdmin);
  discordSettingsRoutes(
    app,
    options.discordSettings,
    requireAdmin,
    options.registerDiscord,
  );
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
  if (options.catalogUpdates)
    catalogUpdateRoutes(app, options.catalogUpdates, requireAdmin);
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

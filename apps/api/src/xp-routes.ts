/** Coherent public tracker and authenticated, CSRF-bound import endpoints. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './types.js';
import type { XpStore } from './xp-types.js';
import { fetchWomCompetition } from './wom.js';
export type XpAuthorize = (
  request: FastifyRequest,
  write?: boolean,
) => Promise<{ id: string; displayName: string }>;
export function xpPublicRoutes(app: FastifyInstance, store: XpStore) {
  app.get('/api/v1/xp/tracker', async (request, reply) => {
    const snapshot = await store.tracker(),
      etag = '"' + snapshot.revision + '"';
    reply
      .header('ETag', etag)
      .header('Cache-Control', 'public, max-age=0, must-revalidate');
    const candidates = (request.headers['if-none-match'] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^W\//u, ''));
    if (candidates.includes(etag) || candidates.includes('*'))
      return reply.code(304).send();
    return snapshot;
  });
}
export function xpAdminRoutes(
  app: FastifyInstance,
  store: XpStore,
  requireAdmin: XpAuthorize,
  fetchCompetition: typeof fetchWomCompetition = fetchWomCompetition,
) {
  const secured = {
    onRequest: async (request: FastifyRequest) => {
      await requireAdmin(request, true);
    },
  };
  app.post<{ Body: { competitionUrl: string; kind?: 'SKILL' } }>(
    '/api/v1/admin/xp/imports/preview',
    {
      ...secured,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['competitionUrl'],
          properties: {
            competitionUrl: { type: 'string', minLength: 1, maxLength: 2048 },
            kind: { const: 'SKILL' },
          },
        },
      },
    },
    async (req) => {
      const admin = await requireAdmin(req, true),
        snapshot = await fetchCompetition(req.body.competitionUrl);
      return store.preview(snapshot, admin.id);
    },
  );
  app.post<{
    Body: {
      previewToken: string;
      expectedRevision: string;
      acknowledgeCorrections?: boolean;
    };
  }>(
    '/api/v1/admin/xp/imports',
    {
      ...secured,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['previewToken', 'expectedRevision'],
          properties: {
            previewToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            expectedRevision: {
              type: 'string',
              pattern: '^xp-[1-9][0-9]*$',
              maxLength: 40,
            },
            acknowledgeCorrections: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const admin = await requireAdmin(req, true),
        key = req.headers['idempotency-key'];
      if (
        typeof key !== 'string' ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
          key,
        )
      )
        throw new ApiError(400, 'A UUID Idempotency-Key is required.');
      return store.apply(
        req.body.previewToken,
        req.body.expectedRevision,
        key,
        admin.id,
        admin.displayName,
        req.body.acknowledgeCorrections ?? false,
      );
    },
  );
  app.get(
    '/api/v1/admin/xp/imports',
    {
      onRequest: async (req) => {
        await requireAdmin(req);
      },
    },
    async (req) => {
      await requireAdmin(req);
      return store.history();
    },
  );
}

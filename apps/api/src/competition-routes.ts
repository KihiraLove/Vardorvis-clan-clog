import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CompetitionPreviewInput } from '@clog/domain';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';
import type { CompetitionService } from './route-services.js';
import { fetchCompetition } from './competition-wom.js';
import { PreviewWork } from './preview-work.js';
import { matchesEtag } from './projection-cache.js';
type Authorize = (
  request: FastifyRequest,
  write?: boolean,
) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>;
export function competitionRoutes(
  app: FastifyInstance,
  store?: CompetitionService,
  authorize?: Authorize,
  fetchSource = fetchCompetition,
  previews = new PreviewWork(),
) {
  const available = () => {
    if (!store) throw new ApiError(503, 'Competition service unavailable.');
    return store;
  };
  const staff = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    return authorize(request, write);
  };
  app.get('/api/v1/competitions/activities', async (request, reply) => {
    const service = available();
    if (typeof service.activitySnapshot === 'function') {
      const snapshot = await service.activitySnapshot(),
        etag = 'W/"' + snapshot.revision + '"';
      reply
        .header('Cache-Control', 'public, max-age=0, must-revalidate')
        .header('ETag', etag)
        .header('X-Server-Now', snapshot.serverNow);
      if (matchesEtag(request.headers['if-none-match'], etag))
        return reply.code(304).send();
      return reply.type('application/json').send(snapshot.body);
    }
    reply.header('Cache-Control', 'no-store');
    return service.activities();
  });
  app.post<{
    Body: CompetitionPreviewInput;
  }>(
    '/api/v1/admin/competitions/preview',
    {
      onRequest: async (r) => {
        await staff(r, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['competitionUrl'],
          properties: {
            competitionUrl: { type: 'string', minLength: 1, maxLength: 2048 },
            kind: { enum: ['SKILL', 'ACTIVITY'] },
            pageIds: {
              type: 'array',
              maxItems: 200,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 100 },
            },
          },
        },
      },
    },
    async (r, reply) => {
      const actor = await staff(r, true),
        service = available();
      return previews.run(r, reply, actor.id, async (signal) => {
        const snapshot = await fetchSource(
          r.body.competitionUrl,
          await service.clock(),
          fetch,
          signal,
        );
        signal.throwIfAborted();
        if (
          snapshot.competition.kind === 'SKILL' &&
          snapshot.lifecycle === 'finished' &&
          actor.role !== 'admin'
        )
          throw new ApiError(
            403,
            'Only the administrator can import XP results.',
          );
        if (
          r.body.kind !== undefined &&
          r.body.kind !== snapshot.competition.kind
        )
          throw new ApiError(
            422,
            'The legacy kind hint does not match WOM metadata. Detected kind: ' +
              snapshot.competition.kind +
              '.',
          );
        return service.preview(snapshot, actor.id, r.body.pageIds);
      });
    },
  );
  app.post<{
    Body: {
      previewToken: string;
      expectedRevision: string;
      scheduleRevision: string;
      acknowledgeCorrections?: boolean;
    };
  }>(
    '/api/v1/admin/competitions/imports',
    {
      onRequest: async (r) => {
        await staff(r, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['previewToken', 'expectedRevision', 'scheduleRevision'],
          properties: {
            previewToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            expectedRevision: {
              type: 'string',
              pattern: '^xp-[1-9][0-9]*$',
              maxLength: 40,
            },
            scheduleRevision: {
              type: 'string',
              pattern: '^schedules-[1-9][0-9]*$',
              maxLength: 30,
            },
            acknowledgeCorrections: { type: 'boolean' },
          },
        },
      },
    },
    async (r) => {
      const actor = await staff(r, true),
        key = r.headers['idempotency-key'];
      if (
        typeof key !== 'string' ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
          key,
        )
      )
        throw new ApiError(400, 'A UUID Idempotency-Key is required.');
      return available().apply(
        r.body.previewToken,
        r.body.expectedRevision,
        r.body.scheduleRevision,
        key,
        actor.id,
        actor.displayName,
        actor.role,
        r.body.acknowledgeCorrections ?? false,
      );
    },
  );
}

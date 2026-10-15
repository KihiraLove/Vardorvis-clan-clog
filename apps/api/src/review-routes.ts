/** Allowlisted, CSRF-protected review API with versioned queue and private audit. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './types.js';
import type { ReviewRouteStore } from './route-services.js';
import type {
  ReviewAction,
  ManualSubmissionInput,
  ReviewCorrection,
} from './review-types.js';
type Authorize = (
  request: FastifyRequest,
  write?: boolean,
) => Promise<{ id: string; displayName: string; role?: 'admin' | 'moderator' }>;
const version = { type: 'integer', minimum: 1, maximum: 2147483647 } as const;
const reason = { type: 'string', maxLength: 1000 } as const;
export function reviewRoutes(
  app: FastifyInstance,
  store: ReviewRouteStore,
  authorize: Authorize,
) {
  const guard =
    (write = false) =>
    async (req: FastifyRequest) => {
      await authorize(req, write);
    };
  const filterOwner = async (request: FastifyRequest) => {
    const actor = await authorize(request, true);
    if (actor.role !== 'admin')
      throw new ApiError(
        403,
        'Only the administrator can change submission filters.',
      );
    return actor;
  };
  app.get(
    '/api/v1/admin/submission-filters',
    { onRequest: guard() },
    async () => {
      if (!store.submissionFilters)
        throw new ApiError(503, 'Submission filters are unavailable.');
      return store.submissionFilters();
    },
  );
  app.put<{ Body: { filterCollected: boolean; expectedRevision: string } }>(
    '/api/v1/admin/submission-filters',
    {
      onRequest: async (request) => {
        await filterOwner(request);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['filterCollected', 'expectedRevision'],
          properties: {
            filterCollected: { type: 'boolean' },
            expectedRevision: {
              type: 'string',
              pattern: '^submission-filters-[1-9][0-9]*$',
              maxLength: 40,
            },
          },
        },
      },
    },
    async (req) => {
      const actor = await filterOwner(req);
      if (!store.saveSubmissionFilters)
        throw new ApiError(503, 'Submission filters are unavailable.');
      return store.saveSubmissionFilters(
        req.body.filterCollected,
        req.body.expectedRevision,
        actor.id,
      );
    },
  );
  app.post<{ Body: ManualSubmissionInput }>(
    '/api/v1/admin/submissions',
    {
      onRequest: guard(true),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'itemId',
            'collectorName',
            'collectedOn',
            'hardcore',
            'approve',
          ],
          properties: {
            itemId: version,
            collectorName: { type: 'string', minLength: 1, maxLength: 80 },
            collectedOn: {
              type: 'string',
              pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
            },
            hardcore: { type: 'boolean' },
            proofUrl: { type: 'string', maxLength: 2048 },
            approve: { type: 'boolean' },
            reason,
          },
        },
      },
    },
    async (req, reply) => {
      const actor = await authorize(req, true);
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string')
        throw new ApiError(400, 'A UUID Idempotency-Key is required.');
      return reply
        .code(201)
        .send(
          await store.createManual(req.body, actor.id, actor.displayName, key),
        );
    },
  );
  app.get<{
    Querystring: {
      status?: 'pending' | 'reviewed';
      unmatched?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/api/v1/admin/submissions',
    {
      onRequest: guard(),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'reviewed'] },
            unmatched: { type: 'string', enum: ['true'] },
            limit: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' },
            cursor: { type: 'string', maxLength: 1024 },
          },
        },
      },
    },
    async (req) => {
      const status = req.query.status ?? 'pending';
      if (status === 'reviewed' && req.query.unmatched !== undefined)
        throw new ApiError(
          400,
          'Unmatched filter only applies to pending claims.',
        );
      return store.queue(
        status,
        req.query.unmatched === 'true',
        Number(req.query.limit ?? '20'),
        req.query.cursor,
      );
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    '/api/v1/admin/submissions/:id',
    {
      onRequest: guard(),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', maxLength: 1024 },
            limit: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' },
          },
        },
      },
    },
    async (req) => {
      const result = await store.detail(
        req.params.id,
        req.query.cursor,
        Number(req.query.limit ?? '20'),
      );
      if (!result) throw new ApiError(404, 'Submission not found.');
      return result;
    },
  );
  const editSchema = {
    body: {
      type: 'object',
      additionalProperties: false,
      required: [
        'expectedVersion',
        'itemId',
        'collectorName',
        'collectedOn',
        'hardcore',
        'reason',
      ],
      properties: {
        expectedVersion: version,
        itemId: version,
        collectorName: { type: 'string', minLength: 1, maxLength: 80 },
        collectedOn: {
          type: 'string',
          pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        },
        hardcore: { type: 'boolean' },
        reason,
      },
    },
  };
  app.patch<{
    Params: { id: string };
    Body: ReviewCorrection & { expectedVersion: number };
  }>(
    '/api/v1/admin/submissions/:id',
    { onRequest: guard(true), schema: editSchema },
    async (req) => {
      const actor = await authorize(req, true);
      return store.mutate(
        req.params.id,
        req.body.expectedVersion,
        {
          itemId: req.body.itemId,
          collectorName: req.body.collectorName,
          collectedOn: req.body.collectedOn,
          hardcore: req.body.hardcore,
          reason: req.body.reason,
        },
        actor.id,
        actor.displayName,
      );
    },
  );
  // Note-only writes have a distinct contract: they do not require a
  // resolved canonical item and cannot change an approved collection credit.
  app.patch<{
    Params: { id: string };
    Body: { expectedVersion: number; note: string };
  }>(
    '/api/v1/admin/submissions/:id/note',
    {
      onRequest: guard(true),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'note'],
          properties: {
            expectedVersion: version,
            note: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (req) => {
      const actor = await authorize(req, true);
      return store.mutate(
        req.params.id,
        req.body.expectedVersion,
        { note: req.body.note },
        actor.id,
        actor.displayName,
      );
    },
  );
  for (const action of ['approve', 'reject', 'revoke'] as const) {
    app.post<{
      Params: { id: string };
      Body: { expectedVersion: number; reason?: string };
    }>(
      '/api/v1/admin/submissions/:id/' + action,
      {
        onRequest: guard(true),
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required:
              action === 'approve'
                ? ['expectedVersion']
                : ['expectedVersion', 'reason'],
            properties: {
              expectedVersion: version,
              ...(action === 'approve' ? {} : { reason }),
            },
          },
        },
      },
      async (req) => {
        const actor = await authorize(req, true);
        const command: ReviewAction = {
          expectedVersion: req.body.expectedVersion,
          action,
          ...(action === 'approve' ? {} : { reason: req.body.reason }),
        };
        return store.mutate(
          req.params.id,
          command.expectedVersion,
          command,
          actor.id,
          actor.displayName,
        );
      },
    );
  }
}

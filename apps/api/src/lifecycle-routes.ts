/** Historical source/results stay private; archive writes are owner CLI operations. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LifecycleError,
  type PgLifecycleStore,
  type LifecycleResource,
  type LifecycleView,
} from '@clog/database/dist/lifecycle.js';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';
export function lifecycleRoutes(
  app: FastifyInstance,
  store: PgLifecycleStore | undefined,
  authorize:
    | ((
        request: FastifyRequest,
      ) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>)
    | undefined,
) {
  const guard = async (request: FastifyRequest) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    if ((await authorize(request)).role !== 'admin')
      throw new ApiError(
        403,
        'Only the administrator can read lifecycle history.',
      );
  };
  const call = async <T>(run: (service: PgLifecycleStore) => Promise<T>) => {
    if (!store) throw new ApiError(503, 'Lifecycle history unavailable.');
    try {
      return await run(store);
    } catch (error) {
      if (error instanceof LifecycleError)
        throw new ApiError(error.status, error.message);
      throw error;
    }
  };
  const params = {
    type: 'object',
    required: ['resource'],
    properties: {
      resource: { type: 'string', enum: ['schedules', 'competitions'] },
    },
  };
  app.get<{
    Params: { resource: LifecycleResource };
    Querystring: { view?: LifecycleView; cursor?: string; limit?: string };
  }>(
    '/api/v1/admin/lifecycle/:resource',
    {
      onRequest: guard,
      schema: {
        params,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['current', 'archived'] },
            cursor: { type: 'string', maxLength: 1024 },
            limit: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' },
          },
        },
      },
    },
    (request) =>
      call((service) =>
        service.list(
          request.params.resource,
          request.query.view,
          request.query.cursor,
          Number(request.query.limit ?? 20),
        ),
      ),
  );
  app.get<{ Params: { resource: LifecycleResource; id: string } }>(
    '/api/v1/admin/lifecycle/:resource/:id',
    {
      onRequest: guard,
      schema: {
        params: {
          ...params,
          required: ['resource', 'id'],
          properties: {
            ...params.properties,
            id: { type: 'string', maxLength: 36 },
          },
        },
      },
    },
    (request) =>
      call((service) =>
        service.detail(request.params.resource, request.params.id),
      ),
  );
}

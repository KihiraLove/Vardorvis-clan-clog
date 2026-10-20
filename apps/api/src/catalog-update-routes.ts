/** Installation upgrade review is administrator-only, including discovery and retries. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CatalogUpdateError,
  type PgCatalogUpdates,
} from '@clog/database/dist/catalog-update-store.js';
import type { CatalogUpdateSelection } from '@clog/domain';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';
type Authorize = (
  request: FastifyRequest,
  write?: boolean,
) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>;
export type CatalogUpdateService = Pick<
  PgCatalogUpdates,
  'preview' | 'seen' | 'apply' | 'rescan' | 'image'
>;
export function catalogUpdateRoutes(
  app: FastifyInstance,
  store: CatalogUpdateService,
  authorize?: Authorize,
) {
  const admin = async (r: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Admin sign-in is not configured.');
    const actor = await authorize(r, write);
    if (actor.role !== 'admin')
      throw new ApiError(
        403,
        'Only the administrator can review catalog updates.',
      );
    return actor;
  };
  const run = async <T>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CatalogUpdateError)
        throw new ApiError(error.status, error.message);
      throw error;
    }
  };
  const key = (r: FastifyRequest) => {
    const value = r.headers['idempotency-key'];
    if (
      typeof value !== 'string' ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
        value,
      )
    )
      throw new ApiError(400, 'A UUID Idempotency-Key is required.');
    return value;
  };
  app.get('/api/v1/admin/catalog-updates', async (r, reply) => {
    const actor = await admin(r);
    reply.header('Cache-Control', 'private, no-store');
    return run(() => store.preview(actor.id));
  });
  const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  for (const operation of ['seen', 'rescan'] as const)
    app.post<{ Body: { revision: string } }>(
      '/api/v1/admin/catalog-updates/' + operation,
      {
        onRequest: async (r) => {
          await admin(r, true);
        },
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['revision'],
            properties: { revision },
          },
        },
      },
      async (r) => {
        const actor = await admin(r, true);
        if (operation === 'seen')
          return run(() => store.seen(actor.id, r.body.revision));
        return run(() => store.rescan(actor.id, r.body.revision, key(r)));
      },
    );
  app.post<{ Body: CatalogUpdateSelection }>(
    '/api/v1/admin/catalog-updates/apply',
    {
      onRequest: async (r) => {
        await admin(r, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['revision', 'catalogRevision', 'apply', 'keep'],
          properties: {
            revision,
            catalogRevision: {
              type: 'string',
              pattern: '^catalog-[1-9][0-9]*$',
              maxLength: 40,
            },
            apply: {
              type: 'array',
              maxItems: 5000,
              uniqueItems: true,
              items: revision,
            },
            keep: {
              type: 'array',
              maxItems: 5000,
              uniqueItems: true,
              items: revision,
            },
          },
        },
      },
    },
    async (r) => {
      const actor = await admin(r, true);
      return run(() => store.apply(actor.id, key(r), r.body));
    },
  );
  app.get<{ Params: { sha: string } }>(
    '/api/v1/catalog/update-images/:sha.webp',
    {
      schema: {
        params: {
          type: 'object',
          required: ['sha'],
          properties: { sha: revision },
        },
      },
    },
    async (r, reply) =>
      reply
        .type('image/webp')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff')
        .send(await run(() => store.image(r.params.sha))),
  );
}

/** Live routes for the existing admin UI; authenticate before reading multipart bodies. */
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, type AdminIdentity } from './types.js';
import { assetIdPattern, IconStorage, MAX_ICON_BYTES } from './icon-storage.js';
import { PgCatalogStore, type NewItem } from './catalog-store.js';
export type RequireAdmin = (
  request: FastifyRequest,
  write?: boolean,
) => Promise<AdminIdentity>;
const uuid = { type: 'string', pattern: assetIdPattern.source };
const ids = {
  type: 'array',
  uniqueItems: true,
  maxItems: 10000,
  items: { type: 'integer', minimum: 1, maximum: 2147483647 },
};
export function catalogRoutes(
  app: FastifyInstance,
  store: PgCatalogStore,
  icons: IconStorage,
  authorize?: RequireAdmin,
) {
  const admin = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Admin sign-in is not configured.');
    return authorize(request, write);
  };
  app.get<{ Params: { id: string } }>(
    '/api/v1/catalog/icons/:id.png',
    async (request, reply) => {
      if (!assetIdPattern.test(request.params.id))
        throw new ApiError(404, 'Icon not found.');
      const asset = await store.asset(request.params.id);
      if (!asset) throw new ApiError(404, 'Icon not found.');
      if (asset.itemId === null) {
        const actor = await admin(request);
        if (asset.actor !== actor.id || asset.expiresAt.getTime() <= Date.now())
          throw new ApiError(404, 'Icon not found.');
      }
      const bytes = await icons.read(asset);
      return reply
        .type('image/png')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Cache-Control',
          asset.itemId === null
            ? 'private, no-store'
            : 'public, max-age=31536000, immutable',
        )
        .send(bytes);
    },
  );
  app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fileSize: MAX_ICON_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
        fieldNameSize: 20,
        headerPairs: 30,
      },
    });
    scope.post(
      '/api/v1/admin/catalog/icons',
      {
        onRequest: async (request) => {
          await admin(request, true);
        },
      },
      async (request, reply) => {
        const actor = await admin(request, true);
        let input: Buffer | undefined,
          mime = '';
        for await (const part of request.parts()) {
          if (part.type !== 'file' || part.fieldname !== 'icon' || input)
            throw new ApiError(400, 'Upload exactly one icon file.');
          input = await part.toBuffer();
          mime = part.mimetype;
        }
        if (!input) throw new ApiError(400, 'Choose an icon.');
        const record = await icons.save(input, mime);
        try {
          return reply.code(201).send(await store.stage(record, actor.id));
        } catch (error) {
          await icons.remove(record.id);
          throw error;
        }
      },
    );
  });
  app.post<{ Body: NewItem }>(
    '/api/v1/admin/catalog/items',
    {
      onRequest: async (request) => {
        await admin(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'iconAssetId', 'pageIds'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            iconAssetId: uuid,
            pageIds: {
              type: 'array',
              minItems: 1,
              maxItems: 2000,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 200 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await admin(request, true),
        key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/u.test(key))
        throw new ApiError(400, 'Supply a stable Idempotency-Key.');
      const name = request.body.name.trim();
      if (
        !name ||
        [...name].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new ApiError(400, 'Enter a nonblank item name.');
      const result = await store.create(
        { ...request.body, name },
        actor.id,
        key,
        (asset) => icons.read(asset),
      );
      return reply.code(201).send(result);
    },
  );
  app.delete<{
    Params: { pageId: string; id: string };
    Body: { expectedRevision: string; expectedVersion: string };
  }>(
    '/api/v1/admin/catalog/pages/:pageId/items/:id',
    {
      onRequest: async (request) => {
        await admin(request, true);
      },
      schema: {
        params: {
          type: 'object',
          required: ['pageId', 'id'],
          properties: {
            pageId: { type: 'string', minLength: 1, maxLength: 200 },
            id: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision', 'expectedVersion'],
          properties: {
            expectedVersion: {
              type: 'string',
              pattern: '^page-[1-9][0-9]*$',
              maxLength: 30,
            },
            expectedRevision: {
              type: 'string',
              pattern: '^catalog-[1-9][0-9]*$',
              maxLength: 30,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await admin(request, true),
        id = Number(request.params.id);
      if (id > 2147483647)
        throw new ApiError(400, 'Choose an existing catalog item.');
      return store.removePageItem(
        request.params.pageId,
        id,
        request.body.expectedRevision,
        request.body.expectedVersion,
        actor.id,
      );
    },
  );
  app.put<{
    Params: { id: string };
    Body: { orderedItemIds: number[]; expectedVersion: string };
  }>(
    '/api/v1/admin/catalog/pages/:id/order',
    {
      bodyLimit: 128 * 1024,
      onRequest: async (request) => {
        await admin(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['orderedItemIds', 'expectedVersion'],
          properties: {
            orderedItemIds: ids,
            expectedVersion: {
              type: 'string',
              pattern: '^page-[1-9][0-9]*$',
              maxLength: 30,
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await admin(request, true);
      return store.reorder(
        request.params.id,
        request.body.orderedItemIds,
        request.body.expectedVersion,
        actor.id,
      );
    },
  );
  app.post<{
    Params: { id: string };
    Body: { gameItemIds: number[]; expectedRevision: string; reason: string };
  }>(
    '/api/v1/admin/catalog/items/:id/aliases',
    {
      onRequest: async (request) => {
        await admin(request, true);
      },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['gameItemIds', 'expectedRevision', 'reason'],
          properties: {
            gameItemIds: { ...ids, minItems: 1, maxItems: 100 },
            expectedRevision: {
              type: 'string',
              pattern: '^catalog-[1-9][0-9]*$',
              maxLength: 30,
            },
            reason: { type: 'string', minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      const actor = await admin(request, true),
        reason = request.body.reason.trim(),
        itemId = Number(request.params.id);
      if (!reason || itemId > 2147483647)
        throw new ApiError(
          400,
          'Choose an item and explain the reconciliation.',
        );
      return store.reconcile(
        itemId,
        request.body.gameItemIds,
        request.body.expectedRevision,
        reason,
        actor.id,
      );
    },
  );
}

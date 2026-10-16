/** Staff catalog taxonomy, canonical edits and reusable page memberships. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RequireAdmin } from './catalog-routes.js';
import type { CatalogRouteStore, IconFiles } from './route-services.js';
import { ApiError } from './types.js';
import { assetIdPattern } from './icon-storage.js';
const revision = {
  type: 'string',
  pattern: '^catalog-[1-9][0-9]*$',
  maxLength: 30,
};
const entityId = { type: 'string', minLength: 1, maxLength: 200 };
const itemId = { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 };
const nameField = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
};
const named = (name: string) => {
  if (!name.trim()) throw new ApiError(400, 'Enter a name.');
  return name.trim();
};
const numericId = (value: string) => {
  const id = Number(value);
  if (id > 2147483647)
    throw new ApiError(400, 'Choose an existing catalog item.');
  return id;
};
export function catalogEditorRoutes(
  app: FastifyInstance,
  store: CatalogRouteStore,
  icons: IconFiles,
  admin: RequireAdmin,
) {
  const writeOptions = {
    onRequest: async (request: FastifyRequest) => {
      await admin(request, true);
    },
  };
  app.post<{ Body: { name: string; expectedRevision: string } }>(
    '/api/v1/admin/catalog/sections',
    {
      ...writeOptions,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'expectedRevision'],
          properties: { name: nameField, expectedRevision: revision },
        },
      },
    },
    async (request, reply) => {
      const actor = await admin(request, true),
        key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(key))
        throw new ApiError(400, 'Provide a stable idempotency key.');
      return reply
        .code(201)
        .send(
          await store.createSection(
            named(request.body.name),
            request.body.expectedRevision,
            actor.id,
            key,
          ),
        );
    },
  );
  app.put<{ Body: { orderedSectionIds: string[]; expectedRevision: string } }>(
    '/api/v1/admin/catalog/sections/order',
    {
      ...writeOptions,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['orderedSectionIds', 'expectedRevision'],
          properties: {
            orderedSectionIds: {
              type: 'array',
              maxItems: 100,
              uniqueItems: true,
              items: entityId,
            },
            expectedRevision: revision,
          },
        },
      },
    },
    async (request) =>
      store.reorderSections(
        request.body.orderedSectionIds,
        request.body.expectedRevision,
        (await admin(request, true)).id,
      ),
  );
  for (const method of ['PATCH', 'DELETE'] as const) {
    app.route<{
      Params: { id: string };
      Body: { name?: string; expectedRevision: string };
    }>({
      method,
      url: '/api/v1/admin/catalog/sections/:id',
      ...writeOptions,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: entityId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required:
            method === 'PATCH'
              ? ['name', 'expectedRevision']
              : ['expectedRevision'],
          properties: {
            ...(method === 'PATCH' ? { name: nameField } : {}),
            expectedRevision: revision,
          },
        },
      },
      handler: async (request) =>
        store.editSection(
          request.params.id,
          method === 'PATCH' ? named(request.body.name!) : null,
          request.body.expectedRevision,
          (await admin(request, true)).id,
        ),
    });
  }
  app.patch<{
    Params: { id: string };
    Body: { name: string; expectedRevision: string };
  }>(
    '/api/v1/admin/catalog/pages/:id',
    {
      ...writeOptions,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: entityId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'expectedRevision'],
          properties: { name: nameField, expectedRevision: revision },
        },
      },
    },
    async (request) =>
      store.renamePage(
        request.params.id,
        named(request.body.name),
        request.body.expectedRevision,
        (await admin(request, true)).id,
      ),
  );
  app.put<{
    Params: { pageId: string; id: string };
    Body: { expectedRevision: string };
  }>(
    '/api/v1/admin/catalog/pages/:pageId/items/:id',
    {
      ...writeOptions,
      schema: {
        params: {
          type: 'object',
          required: ['pageId', 'id'],
          properties: { pageId: entityId, id: itemId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision'],
          properties: { expectedRevision: revision },
        },
      },
    },
    async (request) =>
      store.attachItem(
        request.params.pageId,
        numericId(request.params.id),
        request.body.expectedRevision,
        (await admin(request, true)).id,
      ),
  );
  app.patch<{
    Params: { id: string };
    Body: {
      name: string;
      gameItemIds: number[];
      iconAssetId?: string;
      expectedRevision: string;
    };
  }>(
    '/api/v1/admin/catalog/items/:id',
    {
      ...writeOptions,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: itemId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'gameItemIds', 'expectedRevision'],
          properties: {
            name: nameField,
            gameItemIds: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1, maximum: 2147483647 },
            },
            iconAssetId: { type: 'string', pattern: assetIdPattern.source },
            expectedRevision: revision,
          },
        },
      },
    },
    async (request) =>
      store.editItem(
        numericId(request.params.id),
        { ...request.body, name: named(request.body.name) },
        request.body.expectedRevision,
        (await admin(request, true)).id,
        (asset) => icons.read(asset),
      ),
  );
  app.delete<{ Params: { id: string }; Body: { expectedRevision: string } }>(
    '/api/v1/admin/catalog/items/:id',
    {
      ...writeOptions,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: itemId },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision'],
          properties: { expectedRevision: revision },
        },
      },
    },
    async (request) =>
      store.deleteItem(
        numericId(request.params.id),
        request.body.expectedRevision,
        (await admin(request, true)).id,
      ),
  );
}

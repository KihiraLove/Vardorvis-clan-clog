import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BrandingStorage, MAX_LOGO_BYTES } from './branding-storage.js';
import { defaultBranding, type BrandingStore } from './branding-store.js';
import { assetIdPattern } from './icon-storage.js';
import { ApiError } from './types.js';
import { matchesEtag } from './projection-cache.js';
export function brandingRoutes(
  app: FastifyInstance,
  store?: BrandingStore,
  storage?: BrandingStorage,
  authorize?: (
    request: FastifyRequest,
    write?: boolean,
  ) => Promise<{ id: string; role: 'admin' | 'moderator' }>,
) {
  for (const hardcore of [false, true])
    app.get(
      '/api/v1/branding' + (hardcore ? '/hardcore' : ''),
      async (request, reply) => {
        const value = store ? await store.settings(hardcore) : defaultBranding,
          etag = '"' + value.revision + '"';
        reply
          .header('Cache-Control', 'public, max-age=0, must-revalidate')
          .header('ETag', etag);
        if (matchesEtag(request.headers['if-none-match'], etag))
          return reply.code(304).send();
        return value;
      },
    );
  for (const favicon of [false, true])
    app.get<{ Params: { id: string } }>(
      favicon
        ? '/api/v1/branding/:id/favicon.png'
        : '/api/v1/branding/:id.webp',
      async (request, reply) => {
        if (!assetIdPattern.test(request.params.id))
          throw new ApiError(404, 'Logo not found.');
        if (!store || !storage)
          throw new ApiError(503, 'Logo storage unavailable.');
        const record = await store.asset(request.params.id);
        if (!record) throw new ApiError(404, 'Logo not found.');
        const asset = favicon ? record.favicon : record.logo;
        const bytes = await (favicon ? storage.favicons : storage).read(asset);
        const etag = '"' + asset.sha256 + '"';
        reply
          .header('ETag', etag)
          .header('Cache-Control', 'public, max-age=31536000, immutable');
        if (
          (request.headers['if-none-match'] ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^W\//u, ''))
            .some((s) => s === etag || s === '*')
        )
          return reply.code(304).send();
        return reply.type(favicon ? 'image/png' : 'image/webp').send(bytes);
      },
    );
  async function owner(request: FastifyRequest, write = false) {
    if (!authorize || !store || !storage)
      throw new ApiError(503, 'Clan branding unavailable.');
    const actor = await authorize(request, write);
    if (actor.role !== 'admin')
      throw new ApiError(
        403,
        'Only the administrator can change the clan logo.',
      );
    return actor;
  }
  for (const hardcore of [false, true]) {
    const path = '/api/v1/admin/branding' + (hardcore ? '/hardcore' : '');
    app.get(
      path,
      {
        onRequest: async (request) => {
          await owner(request);
        },
      },
      () => store!.settings(hardcore),
    );
    app.delete<{ Body: { expectedRevision: string } }>(
      path + '/logo',
      {
        onRequest: async (request) => {
          await owner(request, true);
        },
        schema: {
          body: {
            type: 'object',
            required: ['expectedRevision'],
            additionalProperties: false,
            properties: {
              expectedRevision: {
                type: 'string',
                pattern: '^branding-[1-9][0-9]*$',
                maxLength: 40,
              },
            },
          },
        },
      },
      async (request) =>
        store!.save(
          null,
          request.body.expectedRevision,
          (await owner(request, true)).id,
          hardcore,
        ),
    );
    void app.register(async (scope) => {
      await scope.register(multipart, {
        limits: {
          fileSize: MAX_LOGO_BYTES,
          files: 1,
          fields: 0,
          parts: 1,
          fieldNameSize: 20,
          headerPairs: 30,
        },
      });
      scope.put(
        path + '/logo',
        {
          onRequest: async (request) => {
            await owner(request, true);
          },
        },
        async (request) => {
          const actor = await owner(request, true),
            revision = request.headers['if-match'];
          if (
            typeof revision !== 'string' ||
            !/^branding-[1-9][0-9]*$/u.test(revision) ||
            revision.length > 40
          )
            throw new ApiError(400, 'Supply the current logo revision.');
          let input: Buffer | undefined;
          for await (const part of request.parts()) {
            if (part.type !== 'file' || part.fieldname !== 'logo')
              throw new ApiError(400, 'Upload one logo image.');
            input = await part.toBuffer();
            if (part.file.truncated)
              throw new ApiError(413, 'Choose a logo up to 10 MiB.');
          }
          if (!input) throw new ApiError(400, 'Upload one logo image.');
          const record = await storage!.saveLogo(input);
          // A failed read after a lost write receipt cannot establish
          // whether the new logo was committed. Defer reclamation.
          return store!.save(record, revision, actor.id, hardcore);
        },
      );
    });
  }
}

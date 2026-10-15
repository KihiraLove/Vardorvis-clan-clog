import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuneLiteSettingsUpdate } from '@clog/domain';
import type { RuneLiteSettingsStore } from './runelite-settings.js';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';

export function runeLiteSettingsRoutes(
  app: FastifyInstance,
  store?: RuneLiteSettingsStore,
  authorize?: (
    request: FastifyRequest,
    write?: boolean,
  ) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>,
) {
  const staff = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    return authorize(request, write);
  };
  app.get('/api/v1/admin/runelite-settings', async (request) => {
    await staff(request);
    if (!store) throw new ApiError(503, 'RuneLite settings unavailable.');
    return store.settings();
  });
  app.put<{ Body: RuneLiteSettingsUpdate }>(
    '/api/v1/admin/runelite-settings',
    {
      onRequest: async (request) => {
        await staff(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'expectedRevision',
            'matchClanName',
            'clanName',
            'worldPolicies',
            'playerWhitelist',
          ],
          properties: {
            expectedRevision: {
              type: 'string',
              pattern: '^runelite-[1-9][0-9]*$',
              maxLength: 30,
            },
            matchClanName: { type: 'boolean' },
            clanKeyRequirement: {
              type: 'object',
              additionalProperties: false,
              required: ['enabled', 'expectedRevision'],
              properties: {
                enabled: { type: 'boolean' },
                expectedRevision: {
                  type: 'string',
                  pattern: '^clan-key-[1-9][0-9]*$',
                  maxLength: 30,
                },
              },
            },
            clanName: { type: 'string', minLength: 1, maxLength: 80 },
            worldPolicies: {
              type: 'object',
              additionalProperties: false,
              required: ['f2p', 'pvp', 'members', 'hardcore'],
              properties: {
                f2p: { enum: ['reject', 'review', 'allow'] },
                pvp: { enum: ['reject', 'review', 'allow'] },
                members: { enum: ['review', 'allow'] },
                hardcore: { enum: ['review', 'allow'] },
              },
            },
            playerWhitelist: {
              type: 'array',
              maxItems: 200,
              items: { type: 'string', minLength: 1, maxLength: 80 },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await staff(request, true);
      if (!store) throw new ApiError(503, 'RuneLite settings unavailable.');
      return store.update(request.body, actor.id);
    },
  );
}

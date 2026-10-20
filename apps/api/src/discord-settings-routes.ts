import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DiscordSettingsUpdate } from '@clog/domain';
import {
  DiscordSettingsError,
  type DiscordSettingsStore,
} from '@clog/database/dist/discord-settings.js';
import { registerWithCredentials } from '@clog/bot/dist/register.js';
import { ApiError, type AdminIdentity, type StaffAccount } from './types.js';

export function discordSettingsRoutes(
  app: FastifyInstance,
  store?: DiscordSettingsStore,
  authorize?: (
    request: FastifyRequest,
    write?: boolean,
  ) => Promise<AdminIdentity & Pick<StaffAccount, 'role'>>,
  register = registerWithCredentials,
) {
  const owner = async (request: FastifyRequest, write = false) => {
    if (!authorize) throw new ApiError(503, 'Staff sign-in is not configured.');
    const actor = await authorize(request, write);
    if (write && actor.role !== 'admin')
      throw new ApiError(
        403,
        'Only the administrator can manage Discord settings.',
      );
    if (!store) throw new ApiError(503, 'Discord settings are unavailable.');
    return actor;
  };
  const result = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DiscordSettingsError)
        throw new ApiError(error.status, error.message);
      throw error;
    }
  };
  app.get(
    '/api/v1/admin/discord-settings',
    {
      onRequest: async (request) => {
        await owner(request);
      },
    },
    async () => result(() => store!.settings()),
  );
  app.put<{ Body: DiscordSettingsUpdate }>(
    '/api/v1/admin/discord-settings',
    {
      onRequest: async (request) => {
        await owner(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'enabled',
            'applicationId',
            'guildId',
            'testGuildId',
            'limits',
            'expectedRevision',
          ],
          properties: {
            enabled: { type: 'boolean' },
            applicationId: { type: 'string', maxLength: 20 },
            guildId: { type: 'string', maxLength: 20 },
            testGuildId: { type: 'string', maxLength: 20 },
            token: { type: 'string', maxLength: 256 },
            expectedRevision: {
              type: 'string',
              pattern: '^discord-[1-9][0-9]*$',
              maxLength: 30,
            },
            limits: {
              type: 'object',
              additionalProperties: false,
              required: [
                'intakeUser',
                'intakeGuild',
                'searchUser',
                'searchGuild',
              ],
              properties: {
                intakeUser: { type: 'integer', minimum: 1, maximum: 120 },
                intakeGuild: { type: 'integer', minimum: 1, maximum: 120 },
                searchUser: { type: 'integer', minimum: 1, maximum: 600 },
                searchGuild: { type: 'integer', minimum: 1, maximum: 600 },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const actor = await owner(request, true);
      return result(() => store!.update(request.body, actor.id));
    },
  );
  app.post<{ Body: { target: 'guild' | 'test'; expectedRevision: string } }>(
    '/api/v1/admin/discord-settings/register',
    {
      onRequest: async (request) => {
        await owner(request, true);
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'expectedRevision'],
          properties: {
            target: { enum: ['guild', 'test'] },
            expectedRevision: {
              type: 'string',
              pattern: '^discord-[1-9][0-9]*$',
              maxLength: 30,
            },
          },
        },
      },
    },
    async (request) =>
      result(async () => {
        const config = await store!.runtime();
        if (config.revision !== request.body.expectedRevision)
          throw new ApiError(
            409,
            'Discord settings changed. Reload before registering commands.',
          );
        const guild =
          request.body.target === 'test' ? config.testGuildId : config.guildId;
        if (!config.token || !config.applicationId || !guild)
          throw new ApiError(
            422,
            'Save the token, application ID and selected server ID before registering commands.',
          );
        try {
          await register(config.applicationId, guild, config.token);
        } catch {
          throw new ApiError(
            503,
            'Discord command registration failed. Check the saved credentials and bot permissions.',
          );
        }
        return { registered: true, guildId: guild, revision: config.revision };
      }),
  );
}

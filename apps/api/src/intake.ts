/** Dedicated service-token boundary for Discord bot intake; no admin authority. */
import multipart from '@fastify/multipart';
import { screenshotParts, screenshotLimits } from './screenshot-multipart.js';
import type { ProofFiles } from './route-services.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { BotStore } from './route-services.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BotConfig } from './config.js';
import { ApiError, type BotSubmissionInput } from './types.js';

const snowflake = /^\d{17,20}$/u;
export function botSubmission(json: string): BotSubmissionInput {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ApiError(400, 'Invalid submission JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'Invalid submission fields.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'interactionId',
          'guildId',
          'actorDiscordId',
          'rawItemText',
          'itemId',
          'collectorName',
          'hardcore',
        ].includes(key),
    ) ||
    !['interactionId', 'guildId', 'actorDiscordId'].every(
      (key) => typeof input[key] === 'string' && snowflake.test(input[key]),
    ) ||
    typeof input.rawItemText !== 'string' ||
    !input.rawItemText.trim() ||
    input.rawItemText.length > 200 ||
    typeof input.collectorName !== 'string' ||
    !input.collectorName.trim() ||
    input.collectorName.length > 80 ||
    (input.hardcore !== undefined && typeof input.hardcore !== 'boolean') ||
    (input.itemId !== undefined &&
      (!Number.isSafeInteger(input.itemId) ||
        Number(input.itemId) < 1 ||
        Number(input.itemId) > 2147483647))
  )
    throw new ApiError(400, 'Invalid submission fields.');
  return {
    ...input,
    hardcore: input.hardcore ?? false,
  } as unknown as BotSubmissionInput;
}
export function validCollectionDate(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (value.startsWith('0000-')) return false;
  const time = new Date(value + 'T00:00:00.000Z');
  return (
    Number.isFinite(time.getTime()) &&
    time.toISOString().slice(0, 10) === value &&
    value <= today
  );
}
export function claimHash(input: BotSubmissionInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.interactionId,
        input.guildId,
        input.actorDiscordId,
        input.rawItemText,
        input.itemId ?? null,
        input.collectorName,
        input.proofUrl ?? '',
        null, // Preserve the legacy hash field position for existing retries.
        input.hardcore,
        ...(input.image ? [{ screenshot: input.image.sha256 }] : []),
      ]),
    )
    .digest('hex');
}
function requireBot(request: FastifyRequest, config: BotConfig) {
  const authorization = request.headers.authorization;
  const supplied =
    typeof authorization === 'string' &&
    /^Bearer [a-fA-F0-9]{64,}$/u.test(authorization)
      ? authorization.slice(7)
      : '';
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(config.token).digest();
  if (!supplied || !timingSafeEqual(a, b))
    throw new ApiError(401, 'Bot credential is required.');
}
export function botRoutes(
  app: FastifyInstance,
  store: BotStore,
  configuration: BotConfig | (() => Promise<BotConfig | undefined>),
  storage?: ProofFiles,
) {
  const authorized = new WeakMap<FastifyRequest, BotConfig>();
  const check = async (request: FastifyRequest) => {
    const config =
      typeof configuration === 'function'
        ? await configuration()
        : configuration;
    if (!config) throw new ApiError(503, 'Discord submissions are disabled.');
    requireBot(request, config);
    authorized.set(request, config);
  };
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/v1/bot/items',
    {
      onRequest: check,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 200 },
            limit: { type: 'string', pattern: '^([1-9]|1[0-9]|2[0-5])$' },
          },
        },
      },
    },
    async (request) => ({
      items: await store.botItems(
        request.query.q ?? '',
        Number(request.query.limit ?? '25'),
      ),
    }),
  );
  void app.register(async (scope) => {
    await scope.register(multipart, { limits: screenshotLimits });
    scope.post(
      '/api/v1/bot/submissions',
      { onRequest: check },
      async (request, reply) => {
        if (!storage)
          throw new ApiError(503, 'Screenshot storage is unavailable.');
        const { fields, file } = await screenshotParts(request, ['submission']);
        const input = botSubmission(fields.submission!);
        if (input.guildId !== authorized.get(request)!.guildId)
          throw new ApiError(
            403,
            'Submissions are restricted to the configured guild.',
          );
        const image = await storage.save(file!.bytes, file!.mime);
        try {
          const claim = { ...input, image };
          const result = await store.submitClaim(claim, claimHash(claim));
          if (result.imageId !== undefined && result.imageId !== image.id)
            await storage.remove?.(image.id).catch(() => {});
          return reply.code(result.created ? 201 : 200).send(result.receipt);
        } catch (error) {
          // A deterministic rejection rolls this upload back; an uncertain commit
          // retains WebP evidence for reference-checked maintenance.
          if (error instanceof ApiError && error.status < 500)
            await storage.remove?.(image.id).catch(() => {});
          throw error;
        }
      },
    );
  });
}

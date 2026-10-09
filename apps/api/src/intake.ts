/** Dedicated service-token boundary for Discord bot intake; no admin authority. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BotConfig } from './config.js';
import {
  ApiError,
  type BackendStore,
  type BotSubmissionInput,
} from './types.js';

const snowflake = '^\\d{17,20}$';
const proofHosts = new Set([
  'imgur.com',
  'www.imgur.com',
  'm.imgur.com',
  'i.imgur.com',
  'gyazo.com',
  'www.gyazo.com',
  'i.gyazo.com',
]);
function hasWhitespaceOrControl(value: string): boolean {
  return (
    /\s/u.test(value) ||
    [...value].some((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  );
}
export function validProofUrl(value: string): boolean {
  if (!value || value.length > 2048 || hasWhitespaceOrControl(value))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      proofHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
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
        input.proofUrl,
        null, // Preserve the legacy hash field position for existing retries.
        input.hardcore,
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
  store: BackendStore,
  config: BotConfig,
) {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/v1/bot/items',
    {
      onRequest: async (request) => requireBot(request, config),
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
  app.post<{ Body: BotSubmissionInput }>(
    '/api/v1/bot/submissions',
    {
      onRequest: async (request) => requireBot(request, config),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'interactionId',
            'guildId',
            'actorDiscordId',
            'rawItemText',
            'collectorName',
            'proofUrl',
          ],
          properties: {
            interactionId: { type: 'string', pattern: snowflake },
            guildId: { type: 'string', pattern: snowflake },
            actorDiscordId: { type: 'string', pattern: snowflake },
            rawItemText: { type: 'string', minLength: 1, maxLength: 200 },
            itemId: { type: 'integer', minimum: 1, maximum: 2147483647 },
            collectorName: { type: 'string', minLength: 1, maxLength: 80 },
            proofUrl: { type: 'string', minLength: 1, maxLength: 2048 },
            hardcore: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.guildId !== config.guildId)
        throw new ApiError(
          403,
          'Submissions are restricted to the configured guild.',
        );
      if (
        !body.rawItemText.trim() ||
        !body.collectorName.trim() ||
        !validProofUrl(body.proofUrl)
      )
        throw new ApiError(
          422,
          'Item, collector name or HTTPS proof URL is invalid.',
        );
      // The strict schema rejects caller dates; only the database assigns a receipt date.
      const input = { ...body, hardcore: body.hardcore ?? false };
      const result = await store.submitClaim(input, claimHash(input));
      return reply.code(result.created ? 201 : 200).send(result.receipt);
    },
  );
}

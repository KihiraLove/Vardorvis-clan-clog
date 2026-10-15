/** The public browser tester can upload drops without gaining staff access. */
import type { FastifyInstance } from 'fastify';
import { ApiError } from './types.js';

const path = '/api/v1/runelite/submissions';
const origin = 'https://kihiralove.github.io';
const headers = [
  'content-type',
  'idempotency-key',
  'x-clan-api-key',
  'x-clan-api-key-base64',
];

export function runeLiteCors(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url !== path) return;
    reply.header('Vary', 'Origin');
    if (request.headers.origin === origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header(
        'Access-Control-Expose-Headers',
        'Retry-After, X-Error-Category',
      );
    }
  });
  app.options(path, async (request, reply) => {
    reply.header(
      'Vary',
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    );
    const requested = request.headers['access-control-request-headers'];
    if (
      request.headers.origin !== origin ||
      request.headers['access-control-request-method'] !== 'POST' ||
      (requested !== undefined &&
        (typeof requested !== 'string' ||
          requested
            .split(',')
            .some((header) => !headers.includes(header.trim().toLowerCase()))))
    )
      throw new ApiError(
        403,
        'Browser upload origin, method or headers are not allowed.',
      );
    return reply
      .header('Access-Control-Allow-Methods', 'POST')
      .header('Access-Control-Allow-Headers', headers.join(', '))
      .header('Access-Control-Max-Age', '600')
      .code(204)
      .send();
  });
}

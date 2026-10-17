import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WorkDrain, type OperationalDiagnostics } from '@clog/domain';
/** Count transport completion and handler completion separately, including disconnects. */
export function trackHttpWork(
  app: FastifyInstance,
  work: WorkDrain,
  diagnostics: OperationalDiagnostics,
) {
  const requests = new WeakMap<
    FastifyRequest,
    { release: () => void; handled: boolean }
  >();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
    const release = work.enter(request.id);
    if (!release)
      return reply
        .header('Connection', 'close')
        .header('Retry-After', '1')
        .header('Cache-Control', 'no-store')
        .code(503)
        .send({
          error: 'Service is draining. Retry the same request identity.',
        });
    const state = { release, handled: false };
    requests.set(request, state);
    reply.raw.once('close', () => {
      if (state.handled) release();
    });
  });
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const state = requests.get(request),
        release = state ? work.enter(request.id, true) : undefined;
      try {
        return await handler.call(this, request, reply);
      } finally {
        release?.();
        if (state) {
          state.handled = true;
          if (reply.raw.destroyed) state.release();
        }
      }
    };
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const state = requests.get(request);
    if (state) {
      state.handled = true;
      if (reply.raw.destroyed) state.release();
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    requests.get(request)?.release();
    diagnostics.record('request', {
      operation: 'http',
      code: 'REQUEST_COMPLETE',
      correlation: request.id,
      status: reply.statusCode,
      active: work.snapshot().active,
    });
  });
  app.addHook('preClose', async () => {
    void work.stop();
  });
  app.addHook('onClose', async () => {
    await work.stop();
  });
}

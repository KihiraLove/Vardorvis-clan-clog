import Fastify from 'fastify';

export function createApp(
  checkDatabase: () => Promise<void> = async () => {
    throw new Error('Database not configured');
  },
) {
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  });
  app.get('/healthz', async () => ({ status: 'ok', service: 'api' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  app.get('/api/v1/status', async () => ({
    stage: 'foundation',
    catalogReady: false,
    submissionsEnabled: false,
  }));
  return app;
}

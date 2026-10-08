/** Foundation routes only; public/admin feature adapters currently target future routes. */
import Fastify from 'fastify';

/** Inject the readiness probe so tests can exercise failures without a live database. */
export function createApp(
  checkDatabase: () => Promise<void> = async () => {
    throw new Error('Database not configured');
  },
  readSettings: () => Promise<{
    revision: string;
    hardcoreEnabled: boolean;
  }> = async () => ({ revision: 'settings-disabled', hardcoreEnabled: false }),
) {
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie'] },
  });
  // Liveness checks the process; readiness separately checks the migrated database.
  app.get('/healthz', async () => ({ status: 'ok', service: 'api' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
  // Public visibility contains no admin/session data and fails closed in the browser.
  app.get('/api/v1/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await readSettings();
    } catch {
      return reply.code(503).send({ error: 'Settings unavailable' });
    }
  });
  app.get('/api/v1/status', async () => ({
    stage: 'foundation',
    catalogReady: false,
    submissionsEnabled: false,
  }));
  return app;
}

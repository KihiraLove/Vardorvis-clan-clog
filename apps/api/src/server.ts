/** Wire environment configuration, PostgreSQL readiness and graceful HTTP shutdown. */
import pg from 'pg';
import { createApp } from './app.js';

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
    })
  : undefined;
const app = createApp(
  async () => {
    if (!pool) throw new Error('Database not configured');
    // Reading a migration-created view detects both connection and missing-schema failures.
    await pool.query('SELECT item_id FROM item_collection_state LIMIT 1');
  },
  async () => {
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query<{
      hardcore_enabled: boolean;
      version: number;
    }>(
      'SELECT hardcore_enabled, version FROM site_settings WHERE singleton = true',
    );
    const row = result.rows[0];
    if (!row) throw new Error('Site settings missing');
    return {
      hardcoreEnabled: row.hardcore_enabled,
      revision: 'settings-' + row.version,
    };
  },
);
app.addHook('onClose', async () => {
  await pool?.end();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close();
  });
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port');
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });

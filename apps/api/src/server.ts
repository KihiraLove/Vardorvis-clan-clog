import pg from 'pg';
import { createApp } from './app.js';

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
    })
  : undefined;
const app = createApp(async () => {
  if (!pool) throw new Error('Database not configured');
  await pool.query('SELECT item_id FROM item_collection_state LIMIT 1');
});
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

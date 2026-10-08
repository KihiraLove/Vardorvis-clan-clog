/** Runtime composition: validated auth config, durable store and graceful shutdown. */
import pg from 'pg';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { PgStore } from './store.js';
const config = readConfig();
if ((config.auth || config.bot) && !process.env.DATABASE_URL)
  throw new Error(
    'DATABASE_URL is required when auth or bot intake is enabled',
  );
const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      max: 10,
    })
  : undefined;
const store = pool ? new PgStore(pool) : undefined;
const app = createApp(
  store ? () => store.ready() : undefined,
  store ? () => store.settings() : undefined,
  { store, ...config },
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

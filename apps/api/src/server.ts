/** Runtime composition: validated auth config, durable store and graceful shutdown. */
import { checkBotReadiness } from './readiness.js';
import pg from 'pg';
import { observePoolFailures } from './db-pool.js';
import { join } from 'node:path';
import { BrandingStorage } from './branding-storage.js';
import { PgBrandingStore } from './branding-store.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { PgStore } from './store.js';
import { PgCatalogStore } from './catalog-store.js';
import { IconStorage } from './icon-storage.js';
import { PgXpStore } from './xp-store.js';
import { ProofStorage } from './proof-storage.js';
import { PgClanKeyStore, loadClanKeyRoot } from './clan-api-key.js';
import { PgProofStore } from './proof-store.js';
import { PgRuneLiteSettingsStore } from './runelite-settings.js';
import { PgSchedulingStore } from './scheduling-store.js';
import { PgCompetitionStore } from './competition-store.js';
import { PgReviewStore } from './review-store.js';
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
// An idle connection can fail asynchronously after a database restart.
// pg evicts the client, but its EventEmitter 'error' must be consumed.
// Report only a fixed category: driver errors may contain SQL and credentials.
if (pool)
  observePoolFailures(pool, (category) => {
    process.stderr.write(`PostgreSQL idle pool failure: ${category}\n`);
  });
const store = pool ? new PgStore(pool) : undefined;
const icons = config.iconDirectory
  ? new IconStorage(config.iconDirectory)
  : undefined;
if (icons) await icons.initialize();
const logos = config.iconDirectory
  ? new BrandingStorage(join(config.iconDirectory, 'branding'))
  : undefined;
if (logos) await logos.initialize();
const proofs = config.proofDirectory
  ? new ProofStorage(config.proofDirectory)
  : undefined;
if (proofs) await proofs.initialize();
if (config.auth && !proofs)
  throw new Error('PROOF_STORAGE_PATH is required when auth is enabled');
if (config.auth && !icons)
  throw new Error('ICON_STORAGE_PATH is required when auth is enabled');
const clanKeys =
  pool && proofs
    ? new PgClanKeyStore(pool, await loadClanKeyRoot(proofs.directory))
    : undefined;
if (clanKeys) await clanKeys.ensureDefault();
const catalog = pool ? new PgCatalogStore(pool) : undefined;
const app = createApp(
  store ? () => store.ready() : undefined,
  store ? () => store.settings() : undefined,
  {
    store,
    checkBotReady:
      process.env.BOT_ENABLED === 'true' ? checkBotReadiness : undefined,
    catalog,
    icons,
    logos,
    branding: pool ? new PgBrandingStore(pool) : undefined,
    proofs,
    clanKeys,
    proofStore: pool ? new PgProofStore(pool) : undefined,
    runeLiteSettings: pool ? new PgRuneLiteSettingsStore(pool) : undefined,
    scheduling: pool ? new PgSchedulingStore(pool) : undefined,
    competitions: pool ? new PgCompetitionStore(pool) : undefined,
    xp: pool ? new PgXpStore(pool) : undefined,
    review: pool && store ? new PgReviewStore(pool, store) : undefined,
    ...config,
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

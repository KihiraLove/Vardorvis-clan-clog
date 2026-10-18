/** Runtime composition: validated auth config, durable store and graceful shutdown. */
import { checkBotReadiness } from './readiness.js';
import { databaseUrl } from '@clog/database/dist/secrets.js';
import { SecretInputError } from '@clog/domain/server-secrets';
import pg from 'pg';
import { PgDiscordSettingsStore } from '@clog/database/dist/discord-settings.js';
import { observePoolFailures } from './db-pool.js';
import { join } from 'node:path';
import { BrandingStorage } from './branding-storage.js';
import { PgBrandingStore } from './branding-store.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { adminBootstrapRequiredMessage } from './types.js';
import { PgStore } from './store.js';
import { PgAccessControlStore } from './access-control.js';
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
import { PgLifecycleStore } from '@clog/database/dist/lifecycle.js';
import {
  OperationalDiagnostics,
  WorkDrain,
  withinDeadline,
  safeFailure,
} from '@clog/domain';
const diagnostics = new OperationalDiagnostics('api', (record) =>
  process.stderr.write(JSON.stringify(record) + '\n'),
);
function fatal(error: unknown) {
  const failure = safeFailure(error);
  diagnostics.record('process', {
    operation: 'runtime',
    ...failure,
    code:
      failure.code === 'ADMIN_BOOTSTRAP_REQUIRED'
        ? failure.code
        : 'PROCESS_FAILED',
  });
  if (failure.code === 'ADMIN_BOOTSTRAP_REQUIRED')
    process.stderr.write(adminBootstrapRequiredMessage + '\n');
  if (error instanceof SecretInputError)
    process.stderr.write(error.message + '\n');
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
async function main() {
  const config = readConfig();
  const url = databaseUrl(process.env, 'runtime', false);
  if ((config.auth || config.bot) && !url)
    throw new Error(
      'DATABASE_URL is required when auth or bot intake is enabled',
    );
  const pool = url
    ? new pg.Pool({
        connectionString: url,
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
      diagnostics.record('failure', {
        operation: 'pool',
        category: 'database',
        code:
          category === 'database-shutdown'
            ? 'DB_SHUTDOWN'
            : category === 'timeout'
              ? 'DB_TIMEOUT'
              : 'DB_CONNECTION',
      });
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
  const discordSettings =
    pool && proofs
      ? new PgDiscordSettingsStore(
          pool,
          await loadClanKeyRoot(proofs.directory),
        )
      : undefined;
  if (discordSettings) await discordSettings.ensureDefault();
  const managedBot = process.env.BOT_SETTINGS_MODE === 'database';
  const botConfiguration = managedBot
    ? async () => {
        const saved = await discordSettings?.runtime();
        return saved?.enabled
          ? { token: saved.apiToken, guildId: saved.guildId }
          : undefined;
      }
    : undefined;
  const catalog = pool ? new PgCatalogStore(pool) : undefined;
  const work = new WorkDrain();
  const app = createApp(
    store ? () => store.ready() : undefined,
    store ? () => store.settings() : undefined,
    {
      work,
      diagnostics,
      poolMetrics: () => ({
        total: pool?.totalCount ?? 0,
        idle: pool?.idleCount ?? 0,
        waiting: pool?.waitingCount ?? 0,
      }),
      store,
      accessControl: pool ? new PgAccessControlStore(pool) : undefined,
      checkBotReady:
        process.env.BOT_SETTINGS_MODE !== 'disabled' &&
        (managedBot || process.env.BOT_ENABLED === 'true')
          ? checkBotReadiness
          : undefined,
      discordSettings,
      botConfiguration,
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
      lifecycle: pool ? new PgLifecycleStore(pool) : undefined,
      xp: pool ? new PgXpStore(pool) : undefined,
      review: pool && store ? new PgReviewStore(pool, store) : undefined,
      ...config,
    },
  );
  app.addHook('onClose', async () => {
    await work.stop();
    await pool?.end();
  });
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    if (closing) return closing;
    void work.stop();
    diagnostics.record('shutdown', {
      operation: 'runtime',
      code: 'DRAIN_STARTED',
      ...work.snapshot(),
    });
    closing = (async () => {
      const drained = await withinDeadline(async () => {
        const closed = app.close();
        await work.stop();
        // A request admitted before close can become keep-alive idle afterwards.
        // Reap those sockets after its handler and response have both completed.
        app.server.closeIdleConnections();
        await closed;
      }, 20000);
      diagnostics.record('shutdown', {
        operation: 'runtime',
        code: drained ? 'DRAIN_COMPLETE' : 'DRAIN_EXPIRED',
        ...work.snapshot(),
      });
      if (!drained) {
        app.server.closeAllConnections();
        process.exit(1);
      }
    })();
    return closing;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void shutdown().catch(fatal);
    });
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid TCP port');
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
}
void main().catch(fatal);

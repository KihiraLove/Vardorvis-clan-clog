/** Bundled runtime reads the same encrypted settings as the API, never a public endpoint. */
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseUrl } from '@clog/database/dist/secrets.js';
import { PgDiscordSettingsStore } from '@clog/database/dist/discord-settings.js';
import { readBotConfig } from './config.js';

export async function loadSavedConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const pool = new pg.Pool({
    connectionString: databaseUrl(env, 'runtime'),
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
  });
  pool.on('error', () => {}); // The supervisor retries; driver diagnostics never contain credentials.
  try {
    if (!env.PROOF_STORAGE_PATH)
      throw new Error('Private integration storage is required');
    const root = await readFile(
      join(env.PROOF_STORAGE_PATH, '.clan-api-key.secret'),
    );
    const store = new PgDiscordSettingsStore(pool, root);
    const saved = await store.runtime();
    return {
      pool,
      store,
      saved,
      config: saved.enabled
        ? readBotConfig({
            DISCORD_BOT_TOKEN: saved.token,
            DISCORD_GUILD_ID: saved.guildId,
            BOT_API_TOKEN: saved.apiToken,
            API_BASE_URL: env.API_BASE_URL,
          })
        : null,
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/** One read at a time; stopping prevents late reads from reviving the gateway. */
export function watchConfiguration(
  revision: string,
  read: () => Promise<{ revision: string }>,
  changed: () => Promise<void>,
  failed: () => Promise<void>,
  intervalMs = 3000,
) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const next = await read();
      if (!stopped && next.revision !== revision) {
        await changed();
        return;
      }
    } catch {
      if (!stopped) {
        await failed();
        return;
      }
    }
    if (!stopped)
      timer = setTimeout(() => {
        void poll();
      }, intervalMs);
  };
  timer = setTimeout(() => {
    void poll();
  }, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

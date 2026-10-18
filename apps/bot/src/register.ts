/** Explicit, one-command guild upsert. Never register commands during bot startup. */
import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { collectionLogCommand } from './command.js';
import { requireSnowflake } from './config.js';
import { readSecret } from '@clog/domain/server-secrets';
import { loadSavedConfiguration } from './saved-config.js';

export type RegisterRequest = (route: string, body: object) => Promise<unknown>;
export async function registerWithCredentials(
  appId: string,
  guildId: string,
  token: string,
) {
  const rest = new REST({ version: '10', timeout: 8000, retries: 0 }).setToken(
    token,
  );
  await registerGuildCommand(appId, guildId, async (route, body) => {
    await rest.post(route as '/interactions', { body });
  });
}
export async function registerGuildCommand(
  appId: string,
  guildId: string,
  post: RegisterRequest,
): Promise<void> {
  requireSnowflake(appId, 'DISCORD_APPLICATION_ID');
  requireSnowflake(guildId, 'target guild ID');
  // Discord POST upserts by command name. PUT would overwrite unrelated commands.
  await post(
    Routes.applicationGuildCommands(appId, guildId),
    collectionLogCommand.toJSON(),
  );
}
export async function registerFromEnv(
  mode: 'test' | 'guild',
  env: NodeJS.ProcessEnv = process.env,
  post?: RegisterRequest,
): Promise<void> {
  const appId = requireSnowflake(
    env.DISCORD_APPLICATION_ID,
    'DISCORD_APPLICATION_ID',
  );
  const guildId = requireSnowflake(
    mode === 'test' ? env.DISCORD_TEST_GUILD_ID : env.DISCORD_GUILD_ID,
    mode === 'test' ? 'DISCORD_TEST_GUILD_ID' : 'DISCORD_GUILD_ID',
  );
  const token = readSecret('DISCORD_BOT_TOKEN', env)?.trim();
  if (!token)
    throw new Error('DISCORD_BOT_TOKEN is required for command registration');
  const sender =
    post ??
    (async (route: string, body: object) => {
      await new REST({ version: '10' })
        .setToken(token)
        .post(route as '/interactions', { body });
    });
  await registerGuildCommand(appId, guildId, sender);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mode = process.argv[2];
  if (mode !== 'test' && mode !== 'guild')
    throw new Error('Run register:test or register:guild explicitly');
  if (process.env.BOT_SETTINGS_MODE === 'database') {
    const saved = await loadSavedConfiguration();
    try {
      const config = saved.saved;
      const guild = mode === 'test' ? config.testGuildId : config.guildId;
      if (!config.token)
        throw new Error('Save a Discord token in administration first');
      await registerWithCredentials(config.applicationId, guild, config.token);
    } finally {
      await saved.pool.end();
    }
  } else await registerFromEnv(mode);
  console.log('Guild command registered in the selected guild.');
}

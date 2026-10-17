/** Explicit, one-command guild upsert. Never register commands during bot startup. */
import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { collectionLogCommand } from './command.js';
import { requireSnowflake } from './config.js';
import { readSecret } from '@clog/domain/server-secrets';

export type RegisterRequest = (route: string, body: object) => Promise<unknown>;
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
  await registerFromEnv(mode);
  console.log('Guild command registered in the selected guild.');
}

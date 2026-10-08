/** Keep the Discord gateway disabled until all necessary private settings exist. */
export interface BotConfig {
  discordToken: string;
  guildId: string;
  apiToken: string;
  apiOrigin: string;
}
const snowflake = /^\d{17,20}$/u;
export function requireSnowflake(value: string | undefined, name: string): string {
  if (!value || !snowflake.test(value)) throw new Error(name + ' must be a Discord snowflake');
  return value;
}
export function readBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig | null {
  const discordToken = env.DISCORD_BOT_TOKEN?.trim() ?? '';
  const guildId = env.DISCORD_GUILD_ID?.trim() ?? '';
  const apiToken = env.BOT_API_TOKEN?.trim() ?? '';
  // Disabled for Compose smoke tests and local UI work; partial setups fail closed.
  if (!discordToken && !guildId && !apiToken) return null;
  if (!discordToken || !guildId || !apiToken)
    throw new Error('DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and BOT_API_TOKEN must be configured together');
  requireSnowflake(guildId, 'DISCORD_GUILD_ID');
  if (!/^[a-f\d]{64,}$/iu.test(apiToken))
    throw new Error('BOT_API_TOKEN must be 32+ random bytes encoded as hex');
  const value = env.API_BASE_URL ?? 'http://api:3000';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('API_BASE_URL must be an absolute HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== '/' || !url.hostname
  ) throw new Error('API_BASE_URL must be an HTTP(S) origin without a path or credentials');
  return { discordToken, guildId, apiToken, apiOrigin: url.origin };
}

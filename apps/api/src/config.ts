/** Fail startup for partial/unsafe auth configuration; forwarding trust is explicit. */
import { isIP } from 'node:net';
export interface AuthConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  adminIds: Set<string>;
  secret: string;
  secure: boolean;
}
export interface BotConfig {
  token: string;
  guildId: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!['true', 'false', undefined, ''].includes(env.AUTH_ENABLED))
    throw new Error('AUTH_ENABLED must be true or false');
  const trusted = (env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of trusted) {
    const [ip, prefix, extra] = entry.split('/');
    const family = isIP(ip ?? '');
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/u.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new Error('TRUSTED_PROXY_CIDRS must contain IP addresses or CIDRs');
  }
  const botToken = env.BOT_API_TOKEN?.trim() ?? '';
  const botGuildId = env.DISCORD_GUILD_ID?.trim() ?? '';
  if (!!botToken !== !!botGuildId)
    throw new Error('BOT_API_TOKEN and DISCORD_GUILD_ID must be set together');
  if (botToken && (!/^[a-fA-F0-9]{64,}$/u.test(botToken) || !/^\\d{17,20}$/u.test(botGuildId)))
    throw new Error('Bot token must be 32+ random bytes as hex and guild ID must be a Discord snowflake');
  const bot: BotConfig | undefined = botToken
    ? { token: botToken, guildId: botGuildId }
    : undefined;
  if (env.AUTH_ENABLED !== 'true')
    return {
      auth: undefined,
      bot,
      trustProxy: trusted.length ? trusted : (false as const),
    };
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(name + ' is required when AUTH_ENABLED=true');
    return value;
  };
  const origin = new URL(required('PUBLIC_ORIGIN'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && local && env.NODE_ENV !== 'production'))
  )
    throw new Error(
      'PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback only in development)',
    );
  const redirectUri = required('DISCORD_OAUTH_REDIRECT_URI');
  if (redirectUri !== origin.origin + '/api/v1/auth/discord/callback')
    throw new Error(
      'DISCORD_OAUTH_REDIRECT_URI must match the fixed PUBLIC_ORIGIN callback',
    );
  const clientId = required('DISCORD_CLIENT_ID'),
    adminIds = new Set(
      required('ADMIN_DISCORD_USER_IDS')
        .split(',')
        .map((s) => s.trim()),
    );
  if (![clientId, ...adminIds].every((s) => /^\d{17,20}$/u.test(s)))
    throw new Error('Discord IDs must be 17–20 digit strings');
  const secret = required('SESSION_SECRET');
  if (!/^[a-f\d]{64,}$/iu.test(secret))
    throw new Error(
      'SESSION_SECRET must contain at least 32 random bytes encoded as hex',
    );
  return {
    bot,
    auth: {
      origin: origin.origin,
      clientId,
      clientSecret: required('DISCORD_CLIENT_SECRET'),
      redirectUri,
      adminIds,
      secret,
      secure: origin.protocol === 'https:',
    } satisfies AuthConfig,
    trustProxy: trusted.length ? trusted : (false as const),
  };
}

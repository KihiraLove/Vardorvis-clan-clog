/** Validate account-session configuration. Credentials live only in PostgreSQL. */
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AuthConfig {
  origin: string;
  secret: string;
  secure: boolean;
  devOnly?: true;
}
export interface BotConfig {
  token: string;
  guildId: string;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const iconDirectory = env.ICON_STORAGE_PATH?.trim() || undefined;
  if (iconDirectory && !isAbsolute(iconDirectory))
    throw new Error('ICON_STORAGE_PATH must be absolute');
  if (!['true', 'false', undefined, ''].includes(env.AUTH_ENABLED))
    throw new Error('AUTH_ENABLED must be true or false');
  if (!['true', 'false', undefined, ''].includes(env.DEV_ADMIN_MODE))
    throw new Error('DEV_ADMIN_MODE must be true or false');
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
  if (
    botToken &&
    (!/^[a-fA-F0-9]{64,}$/u.test(botToken) || !/^\d{17,20}$/u.test(botGuildId))
  )
    throw new Error(
      'Bot token must be 32+ random bytes as hex and guild ID must be a Discord snowflake',
    );
  const bot: BotConfig | undefined = botToken
    ? { token: botToken, guildId: botGuildId }
    : undefined;
  const devOnly = env.DEV_ADMIN_MODE === 'true';
  if (!devOnly && env.AUTH_ENABLED !== 'true')
    return {
      auth: undefined,
      iconDirectory,
      bot,
      trustProxy: trusted.length ? trusted : (false as const),
    };
  let origin: URL;
  try {
    origin = new URL(env.PUBLIC_ORIGIN ?? '');
  } catch {
    throw new Error('Admin auth requires a valid PUBLIC_ORIGIN');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    origin.hostname,
  );
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        loopback &&
        env.NODE_ENV === 'development'
      ))
  )
    throw new Error(
      'PUBLIC_ORIGIN must use HTTPS (HTTP loopback only in development)',
    );
  if (devOnly) {
    if (
      env.NODE_ENV !== 'development' ||
      env.AUTH_ENABLED === 'true' ||
      trusted.length ||
      !loopback ||
      origin.protocol !== 'http:'
    )
      throw new Error(
        'DEV_ADMIN_MODE requires development, disabled password auth, no trusted proxies and an HTTP loopback origin',
      );
    return {
      iconDirectory,
      auth: {
        origin: origin.origin,
        secret: randomBytes(32).toString('hex'),
        secure: false,
        devOnly: true as const,
      } satisfies AuthConfig,
      bot,
      trustProxy: false as const,
    };
  }
  const secret = env.SESSION_SECRET?.trim() ?? '';
  if (!/^[a-f\d]{64,}$/iu.test(secret))
    throw new Error(
      'SESSION_SECRET must contain at least 32 random bytes encoded as hex',
    );
  return {
    iconDirectory,
    auth: {
      origin: origin.origin,
      secret,
      secure: origin.protocol === 'https:',
    } satisfies AuthConfig,
    bot,
    trustProxy: trusted.length ? trusted : (false as const),
  };
}

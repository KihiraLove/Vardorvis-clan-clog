/** Database credentials are resolved only inside the consuming process. */
import { readSecret } from '@clog/domain/server-secrets';
export { readSecret } from '@clog/domain/server-secrets';

export function databaseUrl(
  env?: NodeJS.ProcessEnv,
  role?: 'owner' | 'runtime',
  required?: true,
): string;
export function databaseUrl(
  env: NodeJS.ProcessEnv,
  role: 'owner' | 'runtime',
  required: false,
): string | undefined;
export function databaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  role: 'owner' | 'runtime' = 'owner',
  required = true,
) {
  const explicit = readSecret('DATABASE_URL', env);
  if (explicit) {
    try {
      const parsed = new URL(explicit);
      if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname
      )
        throw new Error();
    } catch {
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
    }
    return explicit;
  }
  const name = role === 'owner' ? 'POSTGRES_PASSWORD' : 'APP_DB_PASSWORD';
  const password = readSecret(name, env);
  if (!password) {
    if (!required) return undefined;
    throw new Error(`Set DATABASE_URL or ${name}_FILE`);
  }
  const port = env.DB_PORT || '5432';
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('DB_PORT must be between 1 and 65535');
  const url = new URL('postgresql://127.0.0.1');
  const host = env.DB_HOST || '127.0.0.1';
  url.hostname = host;
  if (url.hostname.toLowerCase() !== host.toLowerCase())
    throw new Error('DB_HOST must be a hostname or bracketed IPv6 address');
  url.port = port;
  url.username = env.DB_USER || (role === 'owner' ? 'clog' : 'clog_runtime');
  url.password = password;
  url.pathname = '/' + encodeURIComponent(env.DB_NAME || 'clog');
  return url.toString();
}

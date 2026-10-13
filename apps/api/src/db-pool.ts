/** Sanitize PostgreSQL idle-client failures without leaking connection details. */
import type pg from 'pg';

export type PoolFailureCategory =
  | 'connection-lost'
  | 'database-shutdown'
  | 'connection-refused'
  | 'timeout'
  | 'unknown';

export function classifyPoolFailure(error: unknown): PoolFailureCategory {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (code === '57P01' || code === '57P02' || code === '57P03')
    return 'database-shutdown';
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    (typeof code === 'string' && /^08[\dA-Z]{3}$/u.test(code))
  )
    return 'connection-lost';
  return 'unknown';
}

/**
 * The pg Pool forwards idle-client errors as EventEmitter errors.
 * A missing listener terminates Node, even though the pool already evicted
 * the failed client. Never log an Error, client, connection URL, or SQL text.
 * Readiness is checked against PostgreSQL on every /readyz request, so this
 * listener must not create a persistent "unhealthy" latch.
 */
export function observePoolFailures(
  pool: Pick<pg.Pool, 'on'>,
  report: (category: PoolFailureCategory) => void,
): void {
  pool.on('error', (error: Error) => {
    report(classifyPoolFailure(error));
  });
}

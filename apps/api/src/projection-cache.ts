/** One immutable result and one in-flight load per resource, never a revision map. */
import type pg from 'pg';
import { transaction } from './transaction.js';
import { ApiError } from './types.js';
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export type Projection<T> = { key: string; data: T; json: string };
export class ProjectionCache<T> {
  private value?: Projection<T>;
  private pending: { key: string; promise: Promise<Projection<T>> } | undefined;
  peek(key: string) {
    return this.value?.key === key ? this.value : undefined;
  }
  put(key: string, data: T): Projection<T> {
    const value = { key, data: freeze(data), json: JSON.stringify(data) };
    this.value = value;
    return value;
  }
  async read(key: string, load: () => Promise<T>): Promise<Projection<T>> {
    const hit = this.peek(key);
    if (hit) return hit;
    if (this.pending?.key === key) return this.pending.promise;
    const promise = load().then((data) => this.put(key, data));
    this.pending = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }
}
export async function projection<T>(
  pool: pg.Pool,
  cache: ProjectionCache<T>,
  resource: string,
  load: (client: pg.PoolClient) => Promise<T>,
) {
  return transaction(pool, 'snapshot', async (client) => {
    await client.query("SET LOCAL statement_timeout='5s'");
    const row = (
      await client.query<{ version: string; now: Date }>(
        'SELECT version::text,clock_timestamp() AS now FROM projection_state WHERE resource=$1',
        [resource],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(503, 'Public projection revision unavailable.');
    const value = await cache.read(
      resource + '-projection-' + row.version,
      () => load(client),
    );

    return { ...value, serverNow: row.now.toISOString() };
  });
}
export function matchesEtag(header: string | undefined, etag: string) {
  const normalized = etag.replace(/^W\//u, '');
  return (header ?? '')
    .split(',')
    .some(
      (value) =>
        value.trim().replace(/^W\//u, '') === normalized ||
        value.trim() === '*',
    );
}

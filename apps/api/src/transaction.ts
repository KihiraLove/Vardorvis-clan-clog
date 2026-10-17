/** Connection lifecycle only. Locks, savepoints, error mapping and replay stay in stores. */
import type pg from 'pg';

export type TransactionMode = 'write' | 'snapshot' | 'preview';
const begin: Record<TransactionMode, string> = {
  write: 'BEGIN',
  snapshot: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  preview: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
};

export async function transaction<T>(
  pool: pg.Pool,
  mode: TransactionMode,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let committing = false;
  let discard = false;
  try {
    await client.query(begin[mode]);
    const result = await action(client);
    committing = true;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // COMMIT may have succeeded remotely. Never retry or replace this outcome
    // with a cleanup error, and never return its connection to the idle pool.
    discard = committing;
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

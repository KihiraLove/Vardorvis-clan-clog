import type pg from 'pg';
import type { SubmissionFilters } from '@clog/domain';
import { ApiError } from './types.js';

export async function readSubmissionFilters(
  database: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  lock = false,
): Promise<SubmissionFilters> {
  const row = (
    await database.query<{ version: number; filter_collected: boolean }>(
      'SELECT version,filter_collected FROM submission_filter_settings WHERE singleton' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  if (!row) throw new ApiError(503, 'Submission filters are unavailable.');
  return {
    revision: 'submission-filters-' + row.version,
    filterCollected: row.filter_collected,
  };
}

export async function isCollectedDuplicate(
  client: pg.PoolClient,
  enabled: boolean,
  itemId: number | null,
  hardcore: boolean,
) {
  return Boolean(
    enabled &&
    itemId !== null &&
    (
      await client.query(
        "SELECT 1 FROM submissions WHERE item_id=$1 AND hardcore=$2 AND status='approved' LIMIT 1",
        [itemId, hardcore],
      )
    ).rowCount,
  );
}

export async function requireUncollected(
  client: pg.PoolClient,
  enabled: boolean,
  itemId: number | null,
  hardcore: boolean,
) {
  if (await isCollectedDuplicate(client, enabled, itemId, hardcore))
    throw new ApiError(
      403,
      'This item is already collected in this world mode.',
    );
}

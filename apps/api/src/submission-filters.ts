import type pg from 'pg';
import type { SubmissionFilters, CollectionType } from '@clog/domain';
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
  collectionType: CollectionType | null = 'regular',
) {
  return Boolean(
    enabled &&
    collectionType === 'regular' &&
    itemId !== null &&
    (
      await client.query(
        "SELECT 1 FROM submissions WHERE item_id=$1 AND hardcore=$2 AND status='approved' AND collection_type='regular' LIMIT 1",
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
  collectionType: CollectionType | null = 'regular',
) {
  if (
    await isCollectedDuplicate(
      client,
      enabled,
      itemId,
      hardcore,
      collectionType,
    )
  )
    throw new ApiError(
      403,
      'Filter out regular duplicates is on and this item already has a Regular collection in this world mode.',
    );
}

/** Call before granting or moving a credit. The canonical lock serializes every writer. */
export async function requireCreditAvailable(
  client: pg.PoolClient,
  itemId: number,
  hardcore: boolean,
  type: CollectionType,
  excludeId?: string,
) {
  await client.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [itemId]);
  const filters = await readSubmissionFilters(client, true);
  if (type === 'regular' && !filters.filterCollected) return;
  const occupied = (
    await client.query(
      "SELECT 1 FROM submissions WHERE item_id=$1 AND hardcore=$2 AND collection_type=$3 AND status='approved' AND ($4::uuid IS NULL OR id<>$4) LIMIT 1",
      [itemId, hardcore, type, excludeId ?? null],
    )
  ).rowCount;
  if (occupied)
    throw new ApiError(
      409,
      type === 'event'
        ? 'An approved Event collection already exists for this item. Revoke it before approving another Event collection.'
        : 'Filter out regular duplicates is on and this item already has a Regular collection in this world mode.',
    );
}

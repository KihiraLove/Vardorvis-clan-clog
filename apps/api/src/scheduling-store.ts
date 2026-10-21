import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transaction } from './transaction.js';
import {
  parseCollectionScheduleInput,
  scheduleIdPattern,
  type CollectionScheduleInput,
  type SchedulingState,
} from '@clog/domain';
import { ApiError } from './types.js';
export interface SchedulingStore {
  state(): Promise<SchedulingState>;
  setEnabled(
    enabled: boolean,
    revision: string,
    actorId: string,
    actorName: string,
  ): Promise<SchedulingState>;
  save(
    input: CollectionScheduleInput,
    revision: string,
    actorId: string,
    actorName: string,
    id?: string,
  ): Promise<SchedulingState>;
  remove(
    id: string,
    revision: string,
    actorId: string,
    actorName: string,
  ): Promise<SchedulingState>;
}
/** Acquire before item/page locks so schedule edits and submissions share one lock order. */
export async function lockScheduling(
  client: pg.PoolClient,
  hardcore = false,
): Promise<boolean> {
  if (hardcore) return false;
  const row = (
    await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM collection_scheduling WHERE singleton=true FOR SHARE',
    )
  ).rows[0];
  if (!row) throw new ApiError(503, 'Scheduling settings unavailable.');
  return row.enabled;
}
export async function readState(
  client: pg.PoolClient,
): Promise<SchedulingState> {
  const row = (
    await client.query<{ enabled: boolean; version: number }>(
      'SELECT enabled,version FROM collection_scheduling WHERE singleton=true',
    )
  ).rows[0];
  if (!row) throw new ApiError(503, 'Scheduling settings unavailable.');
  const schedules = (
    await client.query<{
      id: string;
      title: string;
      startsAt: Date;
      endsAt: Date;
      pageIds: string[];
    }>(
      'SELECT s.id::text,s.title,s.starts_at AS "startsAt",s.ends_at AS "endsAt",array_agg(p.page_id ORDER BY p.page_id) AS "pageIds" ' +
        'FROM collection_log_schedules s JOIN collection_log_schedule_pages p ON p.schedule_id=s.id WHERE s.archived_at IS NULL GROUP BY s.id ORDER BY s.starts_at,s.id LIMIT 501',
    )
  ).rows;
  if (schedules.length > 500)
    throw new ApiError(503, 'Scheduling exceeds supported limits.');
  return {
    enabled: row.enabled,
    revision: 'schedules-' + row.version,
    permanentlyOpenPageIds: [],
    schedules: schedules.map((s) => ({
      ...s,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
    })),
  };
}
async function recordChange(
  client: pg.PoolClient,
  before: SchedulingState,
  actorId: string,
  actorName: string,
  action: string,
) {
  const version = (
    await client.query<{ version: number }>(
      'UPDATE collection_scheduling SET version=version+1 WHERE singleton=true RETURNING version',
    )
  ).rows[0]!.version;
  const after = await readState(client);
  await client.query(
    'INSERT INTO collection_schedule_audit(actor_id,actor_name,action,version,old_values,new_values) VALUES($1,$2,$3,$4,$5,$6)',
    [
      actorId,
      actorName,
      action,
      version,
      JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
  return after;
}
export class PgSchedulingStore implements SchedulingStore {
  constructor(private readonly pool: pg.Pool) {}
  async state() {
    return transaction(this.pool, 'snapshot', async (client) => {
      const state = await readState(client);

      return state;
    });
  }
  private async mutate(
    revision: string,
    actorId: string,
    actorName: string,
    action: string,
    change: (client: pg.PoolClient, before: SchedulingState) => Promise<void>,
  ) {
    return transaction(this.pool, 'write', async (client) => {
      await client.query(
        'SELECT singleton FROM collection_scheduling WHERE singleton=true FOR UPDATE',
      );
      const before = await readState(client);
      if (revision !== before.revision)
        throw new ApiError(
          409,
          'Schedules changed. Reload before saving again.',
        );
      await change(client, before);
      return recordChange(client, before, actorId, actorName, action);
    });
  }
  setEnabled(
    enabled: boolean,
    revision: string,
    actorId: string,
    actorName: string,
  ) {
    return this.mutate(
      revision,
      actorId,
      actorName,
      enabled ? 'enable' : 'disable',
      async (client) => {
        await client.query(
          'UPDATE collection_scheduling SET enabled=$1 WHERE singleton=true',
          [enabled],
        );
      },
    );
  }
  save(
    input: CollectionScheduleInput,
    revision: string,
    actorId: string,
    actorName: string,
    id?: string,
  ) {
    let fields: CollectionScheduleInput;
    try {
      fields = parseCollectionScheduleInput(input);
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : 'Invalid schedule.',
      );
    }
    if (id !== undefined && !scheduleIdPattern.test(id))
      throw new ApiError(404, 'Schedule not found.');
    return this.mutate(
      revision,
      actorId,
      actorName,
      id ? 'edit' : 'create',
      async (client, before) => {
        if (id && !before.schedules.some((s) => s.id === id))
          throw new ApiError(404, 'Schedule not found.');
        if (!id && before.schedules.length >= 500)
          throw new ApiError(422, 'The schedule limit has been reached.');
        const pages = await client.query(
          'SELECT id FROM pages WHERE id=ANY($1::text[]) AND active ORDER BY id FOR SHARE',
          [fields.pageIds],
        );
        if (pages.rowCount !== fields.pageIds.length)
          throw new ApiError(422, 'Choose active collection log pages.');
        const scheduleId = id ?? randomUUID();
        if (id) {
          await client.query(
            'UPDATE collection_log_schedules SET title=$2,starts_at=$3,ends_at=$4 WHERE id=$1',
            [id, fields.title, fields.startsAt, fields.endsAt],
          );
          await client.query(
            'DELETE FROM collection_log_schedule_pages WHERE schedule_id=$1',
            [id],
          );
        } else
          await client.query(
            'INSERT INTO collection_log_schedules(id,title,starts_at,ends_at) VALUES($1,$2,$3,$4)',
            [scheduleId, fields.title, fields.startsAt, fields.endsAt],
          );
        await client.query(
          'INSERT INTO collection_log_schedule_pages(schedule_id,page_id) SELECT $1,unnest($2::text[])',
          [scheduleId, fields.pageIds],
        );
      },
    );
  }
  remove(id: string, revision: string, actorId: string, actorName: string) {
    if (!scheduleIdPattern.test(id))
      throw new ApiError(404, 'Schedule not found.');
    return this.mutate(
      revision,
      actorId,
      actorName,
      'delete',
      async (client, before) => {
        if (!before.schedules.some((s) => s.id === id))
          throw new ApiError(404, 'Schedule not found.');
        await client.query('DELETE FROM collection_log_schedules WHERE id=$1', [
          id,
        ]);
      },
    );
  }
}

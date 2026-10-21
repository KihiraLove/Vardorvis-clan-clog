/** Frozen catalog membership is essential when an unmatched claim is reviewed later. */
import type pg from 'pg';
import type { IntakeSchedulingEvidence } from '@clog/domain';

export async function intakeScheduling(
  client: pg.PoolClient,
  enabled: boolean,
  hardcore: boolean,
  receivedAt: Date,
): Promise<IntakeSchedulingEvidence> {
  const state = (
    await client.query<{ version: number }>(
      'SELECT version FROM collection_scheduling WHERE singleton',
    )
  ).rows[0]!;
  const eventPages =
    hardcore || !enabled
      ? []
      : (
          await client.query<{
            scheduleId: string;
            pageId: string;
            itemIds: number[];
          }>(
            'SELECT s.id::text AS "scheduleId",p.id AS "pageId",array_agg(pi.item_id ORDER BY pi.item_id) AS "itemIds" ' +
              'FROM collection_log_schedules s JOIN collection_log_schedule_pages sp ON sp.schedule_id=s.id ' +
              'JOIN pages p ON p.id=sp.page_id AND p.active JOIN page_items pi ON pi.page_id=p.id JOIN items i ON i.id=pi.item_id AND i.active ' +
              'WHERE s.archived_at IS NULL AND s.starts_at<=$1 AND $1<s.ends_at ' +
              'GROUP BY s.id,p.id ORDER BY s.id,p.id',
            [receivedAt],
          )
        ).rows;
  return {
    receivedAt: receivedAt.toISOString(),
    enabled: enabled && !hardcore,
    revision: 'schedules-' + state.version,
    permanentlyOpenPageIds: [],
    eventPages,
  };
}

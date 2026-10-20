export type CollectionType = 'regular' | 'event';
export interface IntakeSchedulingEvidence {
  receivedAt: string;
  enabled: boolean;
  revision: string;
  permanentlyOpenPageIds: string[];
  eventPages: { scheduleId: string; pageId: string; itemIds: number[] }[];
}
export const collectionTypeLabel = (type: CollectionType | null | undefined) =>
  type === null
    ? 'Awaiting item match'
    : type === 'event'
      ? 'Event collection'
      : 'Regular collection';

/** Only the catalog membership and windows frozen at receipt can establish an event. */
export function classifyCollection(
  evidence: IntakeSchedulingEvidence | null,
  itemId: number | null,
  hardcore: boolean,
) {
  if (hardcore)
    return { collectionType: 'regular' as const, collectionReason: 'hardcore' };
  if (!evidence)
    return { collectionType: 'regular' as const, collectionReason: 'legacy' };
  if (!evidence.enabled)
    return {
      collectionType: 'regular' as const,
      collectionReason: 'scheduling_disabled',
    };
  if (itemId === null)
    return { collectionType: null, collectionReason: 'unmatched' };
  const event = evidence.eventPages.some((p) => p.itemIds.includes(itemId));
  return {
    collectionType: event ? ('event' as const) : ('regular' as const),
    collectionReason: event ? 'timed_event' : 'unscheduled',
  };
}

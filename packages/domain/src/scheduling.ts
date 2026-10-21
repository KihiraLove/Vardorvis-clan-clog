export interface CollectionScheduleInput {
  title: string;
  startsAt: string;
  endsAt: string;
  pageIds: string[];
}
/** Legacy API reply retained by client adapters; current intake never rejects closed pages. */
export const closedCollectionPageMessage =
  'Submissions are closed for this item. At least one associated collection log page must be open.';
export interface CollectionSchedule extends CollectionScheduleInput {
  id: string;
}
export interface SchedulingState {
  revision: string;
  enabled: boolean;
  schedules: CollectionSchedule[];
  permanentlyOpenPageIds: string[];
}
export function parsePermanentPageIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 2000 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !id.trim() ||
        id.length > 100 ||
        id !== id.trim(),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error('Choose up to 2,000 distinct collection log pages.');
  return [...(value as string[])].sort();
}
export const scheduleIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid schedule.');
  return value as Record<string, unknown>;
}
function utcTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(
      value,
    ) ||
    value.startsWith('0000-')
  )
    throw new Error('Use a complete UTC date and time.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error('Invalid schedule date and time.');
  return value;
}
export function parseCollectionScheduleInput(
  value: unknown,
): CollectionScheduleInput {
  const row = record(value);
  if (
    Object.keys(row).some(
      (key) => !['title', 'startsAt', 'endsAt', 'pageIds'].includes(key),
    ) ||
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.title.length > 100 ||
    Array.from(row.title).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    !Array.isArray(row.pageIds) ||
    !row.pageIds.length ||
    row.pageIds.length > 200 ||
    row.pageIds.some(
      (id) => typeof id !== 'string' || !id.trim() || id.length > 100,
    ) ||
    new Set(row.pageIds).size !== row.pageIds.length
  )
    throw new Error(
      'Choose a schedule name and one or more distinct collection log pages.',
    );
  const startsAt = utcTime(row.startsAt),
    endsAt = utcTime(row.endsAt);
  if (startsAt >= endsAt) throw new Error('The end must be after the start.');
  return {
    title: row.title.trim(),
    startsAt,
    endsAt,
    pageIds: [...(row.pageIds as string[])].sort(),
  };
}
export function parseSchedulingState(value: unknown): SchedulingState {
  const row = record(value);
  if (
    typeof row.revision !== 'string' ||
    !/^schedules-[1-9][0-9]*$/u.test(row.revision) ||
    typeof row.enabled !== 'boolean' ||
    !Array.isArray(row.schedules) ||
    row.schedules.length > 500
  )
    throw new Error('Invalid scheduling state.');
  const schedules = row.schedules.map((value) => {
    const { id, ...input } = record(value);
    if (typeof id !== 'string' || !scheduleIdPattern.test(id))
      throw new Error('Invalid schedule ID.');
    return { id, ...parseCollectionScheduleInput(input) };
  });
  if (
    new Set(schedules.map((schedule) => schedule.id)).size !== schedules.length
  )
    throw new Error('Duplicate schedule IDs.');
  return {
    revision: row.revision,
    enabled: row.enabled,
    schedules,
    permanentlyOpenPageIds: parsePermanentPageIds(
      row.permanentlyOpenPageIds === undefined
        ? []
        : row.permanentlyOpenPageIds,
    ),
  };
}
/** Windows include their start and exclude their end. Shared items need any open page. */
export function scheduledItemOpen(
  state: Pick<SchedulingState, 'enabled' | 'schedules'> &
    Partial<Pick<SchedulingState, 'permanentlyOpenPageIds'>>,
  pageIds: readonly string[],
  now: string,
): boolean {
  return (
    !state.enabled ||
    state.schedules.some(
      (schedule) =>
        schedule.startsAt <= now &&
        now < schedule.endsAt &&
        schedule.pageIds.some((id) => pageIds.includes(id)),
    )
  );
}

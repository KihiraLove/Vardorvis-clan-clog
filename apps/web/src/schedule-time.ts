const pad = (value: number) => String(value).padStart(2, '0');
/** Use local components rather than slicing an ISO UTC timestamp for datetime-local. */
export function localScheduleInput(utc: string): string {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid schedule time.');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function localScheduleToUtc(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(value) ||
    value.startsWith('0000-')
  )
    throw new Error('Choose a valid local date and time.');
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    localScheduleInput(date.toISOString()).slice(0, value.length) !== value
  )
    throw new Error(
      'This local time does not exist. Check the date or daylight saving change.',
    );
  return date.toISOString();
}
export const utcScheduleLabel = (utc: string) =>
  new Date(utc)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/u, ' UTC');
const localFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});
export const scheduleTimezone = localFormatter.resolvedOptions().timeZone;
export const localScheduleLabel = (utc: string) =>
  localFormatter.format(new Date(utc));

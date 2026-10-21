import { memo, useCallback, useMemo } from 'react';
import { competitionLifecycle, type WomCompetition } from '@clog/domain';
import type { CompetitionClient } from './competition-api.ts';
import { utcScheduleLabel } from './schedule-time.ts';
import { activityRange } from './activity-range.ts';
import { usePublicPolling } from './use-public-polling.ts';
import { useActivityClock } from './activity-clock.ts';
const empty: WomCompetition[] = [];
type Row = {
  competition: WomCompetition;
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
};
const ActivityRow = memo(function ActivityRow({
  row,
  status,
}: {
  row: Row;
  status: ReturnType<typeof competitionLifecycle>;
}) {
  const c = row.competition;
  return (
    <li className={'activity-competition activity-competition--' + status}>
      <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
        {c.title} ↗
      </a>
      <small className="activity-range">
        <span>
          <time dateTime={c.startsAt} title={row.startUtc}>
            {row.start}
          </time>
          {' -'}
        </span>{' '}
        <time dateTime={c.endsAt} title={row.endUtc}>
          {row.end}
        </time>
      </small>
    </li>
  );
});
export function ActivityCompetitions({
  client,
}: {
  client: CompetitionClient;
}) {
  const read = useCallback(
    (signal: AbortSignal) => client.activities(signal),
    [client],
  );
  const { data, error, retry } = usePublicPolling(
    read,
    'Competitions could not be refreshed.',
  );
  const competitions = useMemo(
    () =>
      data
        ? [...data.competitions].sort(
            (a, b) =>
              Date.parse(b.endsAt) - Date.parse(a.endsAt) || b.id - a.id,
          )
        : empty,
    [data?.competitions],
  );
  const rows = useMemo(
    () =>
      competitions.map((competition) => ({
        competition,
        ...activityRange(competition.startsAt, competition.endsAt),
        startUtc: utcScheduleLabel(competition.startsAt),
        endUtc: utcScheduleLabel(competition.endsAt),
      })),
    [competitions],
  );
  const offset = useMemo(
    () => (data ? Date.parse(data.serverNow) - Date.now() : 0),
    [data?.serverNow],
  );
  const now = useActivityClock(competitions, offset);
  return (
    <aside className="activity-competitions" aria-label="Activity competitions">
      <h2>Activity competitions</h2>
      {error && (
        <p role="alert">
          {error} <button onClick={retry}>Retry competitions</button>
        </p>
      )}
      {!data && !error && <p role="status">Loading competitions…</p>}
      {data?.competitions.length === 0 && <p>No activity competitions yet.</p>}
      <ol>
        {rows.map((row) => (
          <ActivityRow
            key={row.competition.id}
            row={row}
            status={competitionLifecycle(row.competition, now)}
          />
        ))}
      </ol>
    </aside>
  );
}

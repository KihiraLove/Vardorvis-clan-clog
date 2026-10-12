import { useEffect, useState } from 'react';
import { competitionLifecycle, type WomCompetition } from '@clog/domain';
import type { CompetitionClient } from './competition-api.ts';
import { localScheduleLabel, utcScheduleLabel } from './schedule-time.ts';
export function ActivityCompetitions({
  client,
}: {
  client: CompetitionClient;
}) {
  const [data, setData] = useState<WomCompetition[]>(),
    [error, setError] = useState<string>(),
    [now, setNow] = useState(Date.now()),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true,
      pending = false;
    let controller: AbortController | undefined;
    setData(undefined);
    const load = async () => {
      if (!active || pending) return;
      pending = true;
      controller = new AbortController();
      const t = setTimeout(() => controller?.abort(), 10000);
      try {
        const r = await client.activities(controller.signal);
        if (active) {
          setData(
            r.competitions.sort(
              (a, b) =>
                Date.parse(b.endsAt) - Date.parse(a.endsAt) || b.id - a.id,
            ),
          );
          setOffset(Date.parse(r.serverNow) - Date.now());
          setNow(Date.now());
          setError(undefined);
        }
      } catch {
        if (active) setError('Competitions could not be refreshed.');
      } finally {
        pending = false;
        clearTimeout(t);
      }
    };
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 25000);
    const resume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      controller?.abort();
      clearInterval(t);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [client, refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <aside className="activity-competitions" aria-label="Activity competitions">
      <h2>Activity competitions</h2>
      <p className="activity-timezone">
        Times: {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>
            Retry competitions
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading competitions…</p>}
      {data?.length === 0 && <p>No activity competitions yet.</p>}
      <ol>
        {data?.map((c) => {
          const status = competitionLifecycle(c, now + offset);
          return (
            <li
              key={c.id}
              className={'activity-competition activity-competition--' + status}
            >
              <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                {c.title} ↗
              </a>
              <small>
                <span className="activity-status">
                  {status === 'finished'
                    ? 'Finished'
                    : status === 'running'
                      ? 'Running'
                      : 'Future'}
                </span>
                <br />
                Start:{' '}
                <time
                  dateTime={c.startsAt}
                  title={utcScheduleLabel(c.startsAt)}
                >
                  {localScheduleLabel(c.startsAt)}
                </time>
                <br />
                End:{' '}
                <time dateTime={c.endsAt} title={utcScheduleLabel(c.endsAt)}>
                  {localScheduleLabel(c.endsAt)}
                </time>
              </small>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

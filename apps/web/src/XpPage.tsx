/** Event sidebar and skill grid; totals and all events arrive as one validated snapshot. */
import { useEffect, useState } from 'react';
import {
  publicPoller,
  publicRead,
  reportPublicFailure,
} from './public-polling.ts';
import { XpAmount } from './XpAmount.tsx';
import { XpPodium } from './XpPodium.tsx';
import { skills, type XpClient } from './xp-model.ts';
import { eventTotals, sumXp, type XpTracker } from './xp-tracker.ts';
import { defaultSiteCopy, type SiteCopy } from '@clog/domain';
export function XpPage({
  client,
  copy = defaultSiteCopy,
}: {
  client: XpClient;
  copy?: SiteCopy;
}) {
  const [data, setData] = useState<XpTracker>();
  const [selected, setSelected] = useState<number>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const subscription = publicPoller.subscribe(async (signal) => {
      if (active) setLoading(true);
      try {
        const value = await publicRead(client.tracker(signal), signal);
        if (active && !signal.aborted) {
          setData(value);
          setError(undefined);
        }
      } catch {
        if (active && reportPublicFailure(signal))
          setError('XP could not be refreshed. Try again shortly.');
      } finally {
        if (active && reportPublicFailure(signal)) setLoading(false);
      }
    }, true);
    return () => {
      active = false;
      subscription.stop();
    };
  }, [client, refresh]);
  useEffect(() => {
    setData(undefined);
    setSelected(undefined);
  }, [client]);
  const event = data?.events.find((entry) => entry.id === selected);
  const missing = selected !== undefined && !event;
  const totals =
    data && !missing ? (event ? eventTotals(event) : data.totals) : undefined;
  return (
    <section
      className="event-tracker"
      id="xp-tracker"
      aria-label={copy.xpTitle}
    >
      <h1>{copy.xpTitle}</h1>
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>Retry XP</button>
        </p>
      )}
      {loading && !data && <p role="status">Loading clan XP…</p>}
      <div className="event-tracker__layout">
        <nav className="event-sidebar" aria-label="XP events">
          <button
            className="event-choice event-choice--total"
            aria-current={selected === undefined ? 'true' : undefined}
            onClick={() => setSelected(undefined)}
          >
            Total
          </button>
          <div className="event-list">
            {data?.events.map((entry) => (
              <button
                className="event-choice"
                key={entry.id}
                aria-current={selected === entry.id ? 'true' : undefined}
                onClick={() => setSelected(entry.id)}
              >
                {entry.title}
              </button>
            ))}
            {data && !data.events.length && <p>No events added yet.</p>}
          </div>
        </nav>
        <div className="event-skills">
          <div className="skill-panel">
            <div
              className="skill-grid"
              role="group"
              aria-label="Event skill XP"
            >
              {skills.map(([id, name]) => (
                <XpAmount
                  key={id}
                  skill={id}
                  label={name}
                  xp={totals?.[id] ?? null}
                />
              ))}
            </div>
            <div className="skill-panel__total">
              <span>Total XP gained</span>
              <XpAmount xp={totals ? sumXp(totals) : null} label="All skills" />
            </div>
          </div>
          {missing && (
            <div className="event-source">
              <p role="status">
                This event is no longer available. Choose Total or another
                event.
              </p>
            </div>
          )}
        </div>
        <XpPodium
          players={
            missing ? [] : event ? (event.podium ?? []) : (data?.podium ?? [])
          }
          title={event?.title ?? (missing ? 'Unavailable event' : 'Total')}
          sourceUrl={event?.sourceUrl}
        />
      </div>
    </section>
  );
}

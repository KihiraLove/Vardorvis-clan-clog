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
import { usePreparedAdminData } from './admin-route-data.ts';
export function XpPage({
  client,
  admin,
  preview,
  onMode,
  adminControls,
  sample,
  copy = defaultSiteCopy,
}: {
  client: XpClient;
  admin: boolean;
  preview: boolean;
  onMode: (next: boolean) => void;
  adminControls?: ((onApplied: () => void) => React.ReactNode) | undefined;
  sample?: { samples: () => Promise<void>; advance: () => void } | undefined;
  copy?: SiteCopy;
}) {
  const initial = usePreparedAdminData()?.tracker;
  const [data, setData] = useState<XpTracker | undefined>(initial);
  const [selected, setSelected] = useState<number>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!initial);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const subscription = publicPoller.subscribe(
      async (signal) => {
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
      },
      !initial || refresh > 0,
    );
    return () => {
      active = false;
      subscription.stop();
    };
  }, [client, refresh, initial]);
  useEffect(() => {
    setData(initial);
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
      aria-label={admin ? 'XP imports' : copy.xpTitle}
    >
      {!admin && <h1>{copy.xpTitle}</h1>}
      {admin && adminControls?.(() => setRefresh((n) => n + 1))}
      {sample && (
        <details className="preview-options">
          <summary>XP preview controls</summary>
          <button
            className="site-button"
            onClick={() => {
              void sample
                .samples()
                .then(() => setRefresh((n) => n + 1))
                .catch(() => setError('Sample XP could not be loaded.'));
            }}
          >
            Show sample XP
          </button>
          <button className="site-button" onClick={() => sample.advance()}>
            Advance sample Attack results
          </button>
        </details>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>Retry XP</button>
          {!preview && (
            <button onClick={() => onMode(true)}>View XP preview</button>
          )}
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
          {(event || missing) && (
            <div className="event-source">
              {event ? (
                <>
                  <a
                    href={event.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View event on Wise Old Man ↗
                  </a>
                </>
              ) : missing ? (
                <p role="status">
                  This event is no longer available. Choose Total or another
                  event.
                </p>
              ) : null}
            </div>
          )}
        </div>
        <XpPodium
          players={
            missing ? [] : event ? (event.podium ?? []) : (data?.podium ?? [])
          }
          title={event?.title ?? (missing ? 'Unavailable event' : 'Total')}
        />
      </div>
    </section>
  );
}

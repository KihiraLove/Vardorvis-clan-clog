import { useEffect, useRef, useState } from 'react';
import { CompetitionImport } from './CompetitionImport.tsx';
import type { CompetitionClient } from './competition-api.ts';
import {
  parseCollectionScheduleInput,
  type CollectionSchedule,
  type SchedulingState,
} from '@clog/domain';
import type { AdminClient, AdminCatalog } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { classifyAccessFailure } from './admin-session.ts';
import { useAdminAction } from './use-admin-action.ts';
import { usePreparedAdminData, useAdminDraft } from './admin-route-data.ts';
import {
  localScheduleInput,
  localScheduleToUtc,
  localScheduleLabel,
  utcScheduleLabel,
} from './schedule-time.ts';

export function AdminScheduling({
  client,
  session,
  onAccessLost,
  competitionClient,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  competitionClient: CompetitionClient;
}) {
  const initial = usePreparedAdminData();
  const [state, setState] = useState<SchedulingState | undefined>(
    initial?.schedules,
  );
  const [catalog, setCatalog] = useState<AdminCatalog | undefined>(
    initial?.catalog,
  );
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [editingId, setEditingId] = useState<string>();
  const [title, setTitle] = useState('');
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [pageSearch, setPageSearch] = useState('');
  const [removing, setRemoving] = useState<CollectionSchedule>();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const action = useAdminAction(onAccessLost);
  const edited = state?.schedules.find((schedule) => schedule.id === editingId);
  useAdminDraft(
    edited
      ? title !== edited.title ||
          startLocal !== localScheduleInput(edited.startsAt) ||
          endLocal !== localScheduleInput(edited.endsAt) ||
          JSON.stringify(pageIds.slice().sort()) !==
            JSON.stringify(edited.pageIds.slice().sort())
      : !!(title || startLocal || endLocal || pageIds.length),
    action.busy,
  );
  useEffect(() => {
    if (removing && !deleteDialog.current?.open)
      deleteDialog.current?.showModal();
  }, [removing]);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reset = () => {
    setEditingId(undefined);
    setTitle('');
    setStartLocal('');
    setEndLocal('');
    setPageIds([]);
    setPageSearch('');
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    if (initial?.schedules && initial.catalog && refresh === 0) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setState(undefined);
    setError(undefined);
    void Promise.all([
      client.scheduling(controller.signal),
      client.catalog(controller.signal),
    ])
      .then(([state, catalog]) => {
        if (active && !controller.signal.aborted) {
          setState(state);
          setCatalog(catalog);
        }
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (classifyAccessFailure(failure) === 'expired') onAccessLost();
        else setError('Scheduling could not be loaded.');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [client, onAccessLost, refresh]);
  const reload = async (signal: AbortSignal) => {
    const [state, catalog] = await Promise.all([
      client.scheduling(signal),
      client.catalog(signal),
    ]);
    if (!signal.aborted) {
      setState(state);
      setCatalog(catalog);
      reset();
      setRemoving(undefined);
    }
  };
  const busy = action.busy || !state || !catalog;
  const previewUtc = (local: string) => {
    try {
      return utcScheduleLabel(localScheduleToUtc(local));
    } catch {
      return 'Choose a valid local date and time.';
    }
  };
  const edit = (schedule: CollectionSchedule) => {
    setEditingId(schedule.id);
    setTitle(schedule.title);
    setStartLocal(localScheduleInput(schedule.startsAt));
    setEndLocal(localScheduleInput(schedule.endsAt));
    setPageIds(schedule.pageIds);
    setPageSearch('');
    action.setMessage(undefined);
    document.getElementById('schedule-title')?.focus();
  };
  return (
    <>
      <section className="admin-panel scheduling-panel">
        <h2 id="scheduling-toggle-title">
          Track Event collections during scheduled windows
        </h2>
        {error && (
          <p role="alert">
            {error}{' '}
            <button type="button" onClick={() => setRefresh((n) => n + 1)}>
              Retry scheduling
            </button>
          </p>
        )}
        {session.role === 'admin' ? (
          <div className="scheduling-toggle">
            <button
              type="button"
              className="site-button admin-toggle"
              role="switch"
              aria-label="Collection log scheduling"
              aria-describedby="scheduling-toggle-title"
              aria-checked={state?.enabled ?? false}
              disabled={busy}
              onClick={() => {
                if (!state) return;
                const enabled = !state.enabled;
                void action.execute(async (signal) => {
                  const saved = await client.setSchedulingEnabled(
                    enabled,
                    state.revision,
                    session.csrfToken,
                    signal,
                  );
                  if (!signal.aborted) {
                    setState(saved);
                    action.setMessage(
                      enabled ? 'Scheduling enabled.' : 'Scheduling disabled.',
                    );
                  }
                }, reload);
              }}
            >
              {state?.enabled ? 'On' : 'Off'}
            </button>
          </div>
        ) : (
          <p>
            Scheduling is{' '}
            <strong>{state?.enabled ? 'enabled' : 'disabled'}</strong>. Only the
            administrator can change this.
          </p>
        )}
        {state?.enabled && (
          <p className="admin-note">
            Timed windows mark eligible normal-world drops as Event collections.
            Other drops are Regular collections. Every page accepts submissions;
            Hardcore collections are always Regular.
          </p>
        )}
      </section>
      <section className="admin-panel scheduling-panel">
        <h2>Schedule management</h2>
        <CompetitionImport
          client={competitionClient}
          session={session}
          onAccessLost={onAccessLost}
          onApplied={() => setRefresh((n) => n + 1)}
        />
        <p>
          Times use your local timezone: <strong>{timezone}</strong>.
        </p>
        <form
          aria-busy={!state && !error}
          onSubmit={(event) => {
            event.preventDefault();
            if (!state) return;
            void action.execute(async (signal) => {
              const input = parseCollectionScheduleInput({
                title,
                startsAt: localScheduleToUtc(startLocal),
                endsAt: localScheduleToUtc(endLocal),
                pageIds,
              });
              const saved = await client.saveSchedule(
                input,
                state.revision,
                session.csrfToken,
                signal,
                editingId,
              );
              if (!signal.aborted) {
                setState(saved);
                reset();
                action.setMessage(
                  editingId ? 'Schedule updated.' : 'Schedule created.',
                );
              }
            }, reload);
          }}
        >
          <h3>{editingId ? 'Edit schedule' : 'New schedule'}</h3>
          <fieldset className="admin-fieldset" disabled={busy}>
            <label htmlFor="schedule-title">
              Schedule name
              <input
                id="schedule-title"
                value={title}
                maxLength={100}
                required
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="schedule-datetime-field">
              <label htmlFor="schedule-start">
                Start date and time (local)
              </label>
              <div className="schedule-datetime-row">
                <input
                  id="schedule-start"
                  type="datetime-local"
                  step={1}
                  required
                  value={startLocal}
                  onChange={(event) => setStartLocal(event.target.value)}
                />
                <span className="schedule-utc" aria-live="polite">
                  Start UTC:{' '}
                  {startLocal ? previewUtc(startLocal) : 'Choose a start time.'}
                </span>
              </div>
            </div>
            <div className="schedule-datetime-field">
              <label htmlFor="schedule-end">End date and time (local)</label>
              <div className="schedule-datetime-row">
                <input
                  id="schedule-end"
                  type="datetime-local"
                  step={1}
                  required
                  value={endLocal}
                  onChange={(event) => setEndLocal(event.target.value)}
                />
                <span className="schedule-utc" aria-live="polite">
                  End UTC:{' '}
                  {endLocal ? previewUtc(endLocal) : 'Choose an end time.'}
                </span>
              </div>
            </div>
            <label htmlFor="schedule-pages-search">
              Find collection log pages
              <input
                id="schedule-pages-search"
                type="search"
                value={pageSearch}
                onChange={(event) => setPageSearch(event.target.value)}
              />
            </label>
            <fieldset className="schedule-page-list catalog-picker">
              <legend>Collection log pages</legend>
              <div className="catalog-choice-list">
                {!catalog && <p>Loading pages…</p>}
                {catalog?.pages
                  .filter((p) =>
                    (p.name + ' ' + p.category)
                      .toLowerCase()
                      .includes(pageSearch.toLowerCase()),
                  )
                  .map((page) => (
                    <label className="admin-checkbox" key={page.id}>
                      <input
                        type="checkbox"
                        checked={pageIds.includes(page.id)}
                        onChange={(event) =>
                          setPageIds(
                            event.target.checked
                              ? [...pageIds, page.id]
                              : pageIds.filter((id) => id !== page.id),
                          )
                        }
                      />
                      {page.name} ({page.category})
                    </label>
                  ))}
                {pageIds
                  .filter((id) => !catalog?.pages.some((p) => p.id === id))
                  .map((id) => (
                    <label className="admin-checkbox" key={id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setPageIds(pageIds.filter((value) => value !== id))
                        }
                      />
                      Unavailable page: {id} (remove before saving)
                    </label>
                  ))}
              </div>
            </fieldset>
            <p className="admin-note">
              {pageIds.length} pages selected. All selected pages share this
              window.
            </p>
            <div className="admin-actions">
              <button
                className="site-button"
                disabled={
                  !title.trim() || !startLocal || !endLocal || !pageIds.length
                }
              >
                {editingId ? 'Save schedule' : 'Create schedule'}
              </button>
              {editingId && (
                <button type="button" className="site-button" onClick={reset}>
                  Cancel edit
                </button>
              )}
            </div>
          </fieldset>
        </form>
        <h3>Saved schedules</h3>
        {state?.schedules.length === 0 && <p>No schedules yet.</p>}
        <div className="schedule-list">
          {state?.schedules.map((schedule) => (
            <article className="schedule-card" key={schedule.id}>
              <div className="schedule-card__heading">
                <h4>{schedule.title}</h4>
                <span className="admin-badge">
                  {!state.enabled
                    ? 'Inactive while scheduling is disabled'
                    : now < schedule.startsAt
                      ? 'Upcoming'
                      : now < schedule.endsAt
                        ? 'Open now'
                        : 'Ended'}
                </span>
              </div>
              <div className="schedule-card__times">
                <p>
                  Start: {localScheduleLabel(schedule.startsAt)}
                  <br />
                  <span className="schedule-utc">
                    {utcScheduleLabel(schedule.startsAt)}
                  </span>
                </p>
                <p>
                  End: {localScheduleLabel(schedule.endsAt)}
                  <br />
                  <span className="schedule-utc">
                    {utcScheduleLabel(schedule.endsAt)}
                  </span>
                </p>
              </div>
              <p>
                Pages:{' '}
                {schedule.pageIds
                  .map(
                    (id) =>
                      catalog?.pages.find((p) => p.id === id)?.name ??
                      'Unavailable page: ' + id,
                  )
                  .join(', ')}
              </p>
              <div className="admin-actions">
                <button
                  type="button"
                  className="site-button"
                  disabled={busy}
                  onClick={() => edit(schedule)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="site-button site-button--danger"
                  disabled={busy}
                  onClick={() => setRemoving(schedule)}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
        {removing && (
          <dialog
            ref={deleteDialog}
            aria-label="Delete schedule"
            className="schedule-delete-confirm"
            onCancel={() => setRemoving(undefined)}
          >
            <p>
              Delete “{removing.title}”? Pages will follow the remaining
              schedules.
            </p>
            <div className="admin-actions">
              <button
                type="button"
                className="site-button site-button--danger"
                disabled={busy}
                onClick={() => {
                  if (!state) return;
                  void action.execute(async (signal) => {
                    const saved = await client.deleteSchedule(
                      removing.id,
                      state.revision,
                      session.csrfToken,
                      signal,
                    );
                    if (!signal.aborted) {
                      setState(saved);
                      if (editingId === removing.id) reset();
                      setRemoving(undefined);
                      action.setMessage('Schedule deleted.');
                    }
                  }, reload);
                }}
              >
                Confirm delete schedule
              </button>
              <button
                type="button"
                className="site-button"
                disabled={busy}
                onClick={() => setRemoving(undefined)}
              >
                Keep schedule
              </button>
            </div>
          </dialog>
        )}
        {action.error && <p role="alert">{action.error}</p>}
        {action.message && <p role="status">{action.message}</p>}
      </section>
    </>
  );
}

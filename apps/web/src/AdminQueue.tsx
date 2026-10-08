/** Load catalog plus paged claims together, retaining cursor history for previous-page navigation. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  type AdminCatalog,
  type AdminClient,
  type QueueResult,
  type QueueView,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { xpTime } from './XpTables.tsx';
import { SubmissionEditor } from './SubmissionEditor.tsx';
import { ProofLink } from './AdminProofLink.tsx';
export function AdminQueue({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [view, setView] = useState<QueueView>('pending'),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string>();
  const [snapshot, setSnapshot] = useState<{
    view: QueueView;
    cursor: string | undefined;
    catalog: AdminCatalog;
    queue: QueueResult;
  }>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setError(undefined);
    void Promise.all([
      client.catalog(controller.signal),
      client.queue(view, cursor, controller.signal),
    ])
      .then(([catalog, queue]) => {
        if (
          queue.submissions.some(
            (row) =>
              row.itemId !== null &&
              !catalog.items.some((item) => item.id === row.itemId),
          ) ||
          (queue.nextCursor !== null && queue.nextCursor === cursor)
        )
          throw new Error('Inconsistent review snapshot.');
        if (active) setSnapshot({ catalog, queue, view, cursor });
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          onAccessLost();
        else
          setError(
            failure instanceof AdminRequestError
              ? failure.message
              : 'Could not refresh submissions. The last successful view is preserved.',
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, view, cursor, refresh, onAccessLost]);
  // A retained response must match the selected filter/page before it can be acted upon.
  const ready = snapshot?.view === view && snapshot.cursor === cursor;
  const choose = (next: QueueView) => {
    setView(next);
    setCursors([undefined]);
    setSelected(undefined);
    setNotice(undefined);
  };
  return (
    <>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <h2>Submissions</h2>
            <p>
              Review the item, collector, date, proof and hardcore claim before
              making a decision.
            </p>
          </div>
          <button
            className="site-button"
            disabled={loading}
            onClick={() => setRefresh((v) => v + 1)}
          >
            Refresh submissions
          </button>
        </div>
        <div
          className="admin-filters"
          role="group"
          aria-label="Submission views"
        >
          {(['pending', 'unmatched', 'reviewed'] as const).map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={view === id}
              className="site-button"
              onClick={() => choose(id)}
            >
              {id === 'pending'
                ? 'Pending'
                : id === 'unmatched'
                  ? 'Unmatched'
                  : 'Reviewed'}
            </button>
          ))}
        </div>
        {notice && (
          <p role="status" className="admin-success">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="admin-error">
            <p>{error}</p>
            <button
              className="site-button"
              onClick={() => {
                setCursors([undefined]);
                setRefresh((v) => v + 1);
              }}
            >
              Reload current submissions
            </button>
          </div>
        )}
        {loading && <p role="status">Loading {view} submissions…</p>}
        {ready && (
          <ul className="submission-list">
            {snapshot.queue.submissions.map((row) => {
              const item = snapshot.catalog.items.find(
                (item) => item.id === row.itemId,
              );
              return (
                <li
                  key={row.id}
                  className={
                    selected === row.id
                      ? 'submission-card submission-card--selected'
                      : 'submission-card'
                  }
                >
                  <div className="submission-card__item">
                    {item && <img src={item.iconPath} alt="" />}
                    <div>
                      <strong>{item?.name ?? 'Needs item match'}</strong>
                      <span>
                        {item
                          ? 'Item #' + item.id
                          : 'Submitted: ' + row.rawItemText}
                      </span>
                    </div>
                    <span className={'admin-badge admin-badge--' + row.status}>
                      {row.status}
                    </span>
                  </div>
                  <dl className="submission-facts">
                    <div>
                      <dt>Collector</dt>
                      <dd>{row.collectorName}</dd>
                    </div>
                    <div>
                      <dt>Collected on</dt>
                      <dd>{row.collectedOn}</dd>
                    </div>
                    <div>
                      <dt>Claim</dt>
                      <dd>
                        {row.hardcore ? 'Hardcore worlds' : 'Ordinary worlds'}
                      </dd>
                    </div>
                    <div>
                      <dt>Submitted</dt>
                      <dd>{xpTime(row.submittedAt)}</dd>
                    </div>
                  </dl>
                  <div className="admin-actions">
                    <ProofLink url={row.proofUrl} />
                    <button
                      type="button"
                      className="site-button"
                      disabled={loading || Boolean(error)}
                      onClick={() => setSelected(row.id)}
                      aria-label={
                        'Review ' +
                        row.collectorName +
                        ' · ' +
                        (item?.name ?? row.rawItemText)
                      }
                    >
                      Review submission
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {ready && !snapshot.queue.submissions.length && !loading && (
          <p className="admin-empty">No {view} submissions in this view.</p>
        )}
        <div className="admin-pagination">
          <button
            className="site-button"
            disabled={loading || cursors.length === 1}
            onClick={() => {
              setCursors((values) => values.slice(0, -1));
              setSelected(undefined);
            }}
          >
            Previous page
          </button>
          <span>Page {cursors.length}</span>
          <button
            className="site-button"
            disabled={
              loading || !ready || !snapshot.queue.nextCursor || Boolean(error)
            }
            onClick={() => {
              setCursors((values) => [...values, snapshot!.queue.nextCursor!]);
              setSelected(undefined);
            }}
          >
            Next page
          </button>
        </div>
      </section>
      {selected && ready && (
        <SubmissionEditor
          key={selected}
          id={selected}
          catalog={snapshot.catalog}
          client={client}
          session={session}
          disabled={loading || Boolean(error)}
          onAccessLost={onAccessLost}
          onClose={() => setSelected(undefined)}
          onChanged={(status) => {
            setNotice('Saved submission state: ' + status + '.');
            setCursors([undefined]);
            if (status !== 'pending') {
              setView('reviewed');
            }
            setRefresh((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

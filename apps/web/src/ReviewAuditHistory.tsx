/** Bounded history pages retain immutable before/after evidence and explicit stale recovery. */
import { useEffect, useRef, useState } from 'react';
import type { AdminClient, SubmissionDetail } from './admin-model.ts';
import { AdminRequestError } from './admin-api.ts';
import { classifyAccessFailure } from './admin-session.ts';
import { formatUtcTime } from './format-time.ts';
import { collectionTypeLabel } from '@clog/domain';
export function ReviewAuditHistory({
  initial,
  client,
  disabled,
  onAccessLost,
  onReload,
}: {
  initial: SubmissionDetail;
  client: AdminClient;
  disabled: boolean;
  onAccessLost: () => void;
  onReload: () => void;
}) {
  const [detail, setDetail] = useState(initial);
  const [cursors, setCursors] = useState([initial.auditCursor]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load(cursor: string, older: boolean) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    const timer = window.setTimeout(() => request.abort(), 10000);
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.detail(
        initial.submission.id,
        request.signal,
        cursor,
      );
      if (request.signal.aborted) throw new Error('Audit request timed out.');
      if (
        next.auditRevision !== initial.auditRevision ||
        next.submission.version !== initial.submission.version
      )
        throw new AdminRequestError(409);
      if (next.nextAuditCursor === cursor || next.auditCursor !== cursor)
        throw new Error('Inconsistent history page.');
      setDetail(next);
      setCursors((values) =>
        older ? [...values, cursor] : values.slice(0, -1),
      );
    } catch (failure) {
      if (classifyAccessFailure(failure) === 'expired') onAccessLost();
      else
        setError(
          failure instanceof AdminRequestError && failure.status === 409
            ? 'History changed. Reload the submission to browse the latest events.'
            : 'Could not load audit events. The last page is preserved. Reload the submission to try again.',
        );
    } finally {
      clearTimeout(timer);
      controller.current = null;
      setBusy(false);
    }
  }
  return (
    <details className="admin-audit">
      <summary>Audit history ({detail.audit.length} on this page)</summary>
      {!detail.audit.length && <p>No review events recorded yet.</p>}
      <div className="admin-pagination">
        <button
          type="button"
          className="site-button"
          disabled={busy || disabled || !!error || cursors.length === 1}
          aria-busy={busy}
          onClick={() => void load(cursors[cursors.length - 2]!, false)}
        >
          Newer events
        </button>
        <span>History page {cursors.length}</span>
        <button
          type="button"
          className="site-button"
          disabled={busy || disabled || !!error || !detail.nextAuditCursor}
          aria-busy={busy}
          onClick={() => void load(detail.nextAuditCursor!, true)}
        >
          Older events
        </button>
      </div>
      {busy && <p role="status">Loading audit events…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="site-button"
            disabled={busy || disabled}
            onClick={onReload}
          >
            Reload submission
          </button>
        </div>
      )}
      <ol>
        {detail.audit.map((entry) => {
          const fields: [string, string, string][] = [
            ['Status', entry.before.status, entry.after.status],
            [
              'Collection type',
              collectionTypeLabel(entry.before.collectionType),
              collectionTypeLabel(entry.after.collectionType),
            ],
            [
              'Submitted item name',
              entry.before.rawItemText,
              entry.after.rawItemText,
            ],
            [
              'Game item ID',
              String(entry.before.gameItemId ?? 'Not supplied'),
              String(entry.after.gameItemId ?? 'Not supplied'),
            ],
            [
              'Item',
              entry.before.itemId === null
                ? 'Unmatched'
                : '#' + entry.before.itemId,
              entry.after.itemId === null
                ? 'Unmatched'
                : '#' + entry.after.itemId,
            ],
            [
              'Collector',
              entry.before.collectorName,
              entry.after.collectorName,
            ],
            ['Date', entry.before.collectedOn, entry.after.collectedOn],
            [
              'Hardcore',
              entry.before.hardcore ? 'Yes' : 'No',
              entry.after.hardcore ? 'Yes' : 'No',
            ],
            ['Review note', entry.before.reviewNote, entry.after.reviewNote],
          ];
          return (
            <li key={entry.id}>
              <strong>
                {entry.action} · {entry.actorName}
              </strong>
              <p>{formatUtcTime(entry.at)}</p>
              {entry.reason && <p>Reason: {entry.reason}</p>}
              <div className="admin-table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields
                      .filter(([, before, after]) => before !== after)
                      .map(([label, before, after]) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          <td>{before}</td>
                          <td>{after}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

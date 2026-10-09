/** Review saved claims, stage corrections separately and display before/after audit history. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  safeProof,
  dateSourceLabel,
  validateCorrection,
  type AdminCatalog,
  type AdminClient,
  type Correction,
  type Submission,
  type SubmissionDetail,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { xpTime } from './XpTables.tsx';
import { ProofLink } from './AdminProofLink.tsx';
import { useAdminAction } from './use-admin-action.ts';

const draftOf = (row: Submission): Correction => ({
  itemId: row.itemId ?? 0,
  collectorName: row.collectorName,
  collectedOn: row.collectedOn,
  hardcore: row.hardcore,
  reason: '',
});
export function SubmissionEditor({
  id,
  catalog,
  client,
  session,
  disabled,
  onAccessLost,
  onClose,
  onChanged,
}: {
  id: string;
  catalog: AdminCatalog;
  client: AdminClient;
  session: AdminSession;
  disabled: boolean;
  onAccessLost: () => void;
  onClose: () => void;
  onChanged: (status: Submission['status']) => void;
}) {
  const [detail, setDetail] = useState<SubmissionDetail>(),
    [draft, setDraft] = useState<Correction>();
  const [query, setQuery] = useState(''),
    [checked, setChecked] = useState(false);
  const [readError, setReadError] = useState<string>(),
    [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  // A new version invalidates both the draft and the user's previous proof acknowledgment.
  const accept = (next: SubmissionDetail) => {
    setDetail(next);
    setDraft(draftOf(next.submission));
    setChecked(false);
    setReadError(undefined);
  };
  const reload = async (signal: AbortSignal) => {
    const next = await client.detail(id, signal);
    if (!signal.aborted) accept(next);
  };
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setReadError(undefined);
    void client
      .detail(id, controller.signal)
      .then((next) => {
        if (active) accept(next);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          onAccessLost();
        else
          setReadError(
            'Could not load this submission and audit history. Reload before making a decision.',
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, id, refresh, onAccessLost]);
  if (!detail || !draft)
    return (
      <section className="admin-panel">
        {readError ? (
          <>
            <p role="alert">{readError}</p>
            <button
              className="site-button"
              onClick={() => setRefresh((v) => v + 1)}
            >
              Reload submission
            </button>
          </>
        ) : (
          <p role="status">Loading submission…</p>
        )}
      </section>
    );
  const row = detail.submission,
    editable = ['pending', 'approved'].includes(row.status);
  const dirty =
    draft.itemId !== (row.itemId ?? 0) ||
    draft.collectorName.trim() !== row.collectorName ||
    draft.collectedOn !== row.collectedOn ||
    draft.hardcore !== row.hardcore;
  const locked = action.busy || disabled || Boolean(readError),
    proof = safeProof(row.proofUrl);
  const change = (fields: Partial<Correction>) => {
    setDraft({ ...draft, ...fields });
    setChecked(false);
  };
  // Save corrections before approval so the acknowledgment refers to persisted claim fields.
  const perform = (decision?: 'approve' | 'reject' | 'revoke') => {
    void action.execute(async (signal) => {
      if (
        decision === 'approve' &&
        (dirty ||
          !checked ||
          (!proof && row.source !== 'manual') ||
          row.itemId === null)
      )
        throw new Error(
          'Save a specific item match and check the linked proof before approving.',
        );
      if (decision && decision !== 'approve' && !draft.reason.trim())
        throw new Error('Enter a reason for this decision.');
      if (!decision && row.status === 'approved' && !draft.reason.trim())
        throw new Error('Enter a reason for correcting an approved credit.');
      const next = decision
        ? await client.decide(
            id,
            row.version,
            decision,
            draft.reason.trim(),
            session.csrfToken,
            signal,
          )
        : await client.edit(
            id,
            row.version,
            validateCorrection(draft, catalog),
            session.csrfToken,
            signal,
          );
      if (signal.aborted) return;
      setDetail({ ...detail, submission: next });
      setDraft(draftOf(next));
      setChecked(false);
      action.setMessage(
        decision
          ? 'Submission ' +
              next.status +
              '. Public credit follows this saved decision.'
          : 'Changes saved. Review the saved claim before approving.',
      );
      onChanged(next.status);
      try {
        await reload(signal);
      } catch (failure) {
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          throw failure;
        if (!signal.aborted)
          setReadError(
            'The change was saved, but audit history could not be refreshed. Reload before continuing.',
          );
      }
    }, reload);
  };
  const selected = catalog.items.find((item) => item.id === draft.itemId);
  const matches = catalog.items.filter(
    (item) =>
      item.name.toLowerCase().includes(query.toLowerCase().trim()) ||
      String(item.id) === query.trim(),
  );
  const options =
    selected && !matches.some((item) => item.id === selected.id)
      ? [selected, ...matches]
      : matches;
  return (
    <section
      className="admin-panel submission-editor"
      aria-labelledby="submission-title"
    >
      <div className="admin-section-heading">
        <div>
          <h2 id="submission-title">Review {row.collectorName}</h2>
          <p>
            {row.status} ·{' '}
            {row.source === 'manual'
              ? 'Manual submission'
              : 'Discord submission'}{' '}
            {row.id} · Version {row.version}
          </p>
        </div>
        <button
          className="site-button"
          disabled={action.busy}
          onClick={onClose}
        >
          Close review
        </button>
      </div>
      <dl className="submission-facts">
        <div>
          <dt>Raw item input</dt>
          <dd>{row.rawItemText || 'No raw text supplied'}</dd>
        </div>
        <div>
          <dt>Date source</dt>
          <dd>{dateSourceLabel(row.dateSource)}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd>{xpTime(row.submittedAt)}</dd>
        </div>
        <div>
          <dt>Proof</dt>
          <dd>
            <ProofLink url={row.proofUrl} source={row.source} />
          </dd>
        </div>
      </dl>
      {action.error && (
        <p role="alert" className="admin-error">
          {action.error}
        </p>
      )}
      {action.message && (
        <p role="status" className="admin-success">
          {action.message}
        </p>
      )}
      {readError && (
        <div role="alert" className="admin-error">
          <p>{readError}</p>
          <button
            className="site-button"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Reload submission
          </button>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          perform();
        }}
      >
        <fieldset disabled={locked || !editable} className="admin-fieldset">
          <legend>Saved claim and corrections</legend>
          <div className="admin-form-grid">
            <label>
              Search catalog items
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div>
              <label htmlFor="canonical-item">Canonical item</label>
              <select
                id="canonical-item"
                required
                size={5}
                value={draft.itemId || ''}
                onChange={(event) =>
                  change({ itemId: Number(event.target.value) })
                }
              >
                <option value="">Select the exact item…</option>
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · #{item.id}
                  </option>
                ))}
              </select>
            </div>
            <label>
              Collector name
              <input
                required
                maxLength={80}
                value={draft.collectorName}
                onChange={(event) =>
                  change({ collectorName: event.target.value })
                }
              />
            </label>
            <label>
              Collection date
              <input
                type="date"
                required
                max={new Date().toISOString().slice(0, 10)}
                value={draft.collectedOn}
                onChange={(event) =>
                  change({ collectedOn: event.target.value })
                }
              />
            </label>
          </div>
          {selected && (
            <p className="admin-note">
              Canonical item #{selected.id} ·{' '}
              {selected.origin === 'manual' ? 'Manual item' : 'Source item'} ·{' '}
              {catalog.pages
                .filter((page) => page.itemIds.includes(selected.id))
                .map((page) => page.name)
                .join(', ')}
            </p>
          )}
          {!matches.length && (
            <p className="admin-note">
              No matching items. Add a missing item in Catalog items before
              resolving this submission.
            </p>
          )}
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={draft.hardcore}
              onChange={(event) => change({ hardcore: event.target.checked })}
            />
            Collected on hardcore worlds
          </label>
          <label>
            Review reason
            <textarea
              maxLength={1000}
              rows={3}
              value={draft.reason}
              onChange={(event) =>
                setDraft({ ...draft, reason: event.target.value })
              }
            />
            <span className="admin-note">
              Required for rejection, revocation and corrections to approved
              credits.
            </span>
          </label>
          <div className="admin-actions">
            <button className="site-button" type="submit" disabled={!dirty}>
              Save corrections
            </button>
            <button
              className="site-button"
              type="button"
              disabled={!dirty}
              onClick={() => {
                setDraft(draftOf(row));
                setChecked(false);
              }}
            >
              Discard corrections
            </button>
          </div>
        </fieldset>
        {dirty && (
          <p className="admin-note">
            Save or discard corrections before deciding on this claim.
          </p>
        )}
        {row.status === 'pending' && (
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={checked}
              disabled={
                locked ||
                dirty ||
                (!proof && row.source !== 'manual') ||
                row.itemId === null
              }
              onChange={(event) => setChecked(event.target.checked)}
            />
            {row.source === 'manual'
              ? 'I verified this manual claim and its item, collector, date and world.'
              : 'I checked the linked proof for the saved item, collector, date and hardcore claim.'}
          </label>
        )}
        <div className="admin-actions">
          {row.status === 'pending' && (
            <>
              <button
                className="site-button site-button--approve"
                type="button"
                disabled={
                  locked ||
                  dirty ||
                  !checked ||
                  (!proof && row.source !== 'manual') ||
                  row.itemId === null
                }
                onClick={() => perform('approve')}
              >
                Approve submission
              </button>
              <button
                className="site-button"
                type="button"
                disabled={locked || dirty || !draft.reason.trim()}
                onClick={() => perform('reject')}
              >
                Reject submission
              </button>
            </>
          )}
          {row.status === 'approved' && (
            <button
              className="site-button site-button--danger"
              type="button"
              disabled={locked || dirty || !draft.reason.trim()}
              onClick={() => perform('revoke')}
            >
              Revoke credit
            </button>
          )}
        </div>
      </form>
      <details className="admin-audit">
        <summary>Audit history ({detail.audit.length})</summary>
        {!detail.audit.length && <p>No review events recorded yet.</p>}
        <ol>
          {detail.audit.map((entry) => {
            const fields: [string, string, string][] = [
              ['Status', entry.before.status, entry.after.status],
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
            ];
            return (
              <li key={entry.id}>
                <strong>
                  {entry.action} · {entry.actorName}
                </strong>
                <p>{xpTime(entry.at)}</p>
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
    </section>
  );
}

/** Review saved claims, stage corrections separately and display before/after audit history. */
import { useEffect, useId, useState } from 'react';
import { useAdminDraft } from './admin-route-data.ts';
import { AdminRequestError } from './admin-api.ts';
import { classifyAccessFailure } from './admin-session.ts';
import {
  safeProof,
  safeScreenshotPath,
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
import { ReviewAuditHistory } from './ReviewAuditHistory.tsx';
import { ProofLink } from './AdminProofLink.tsx';
import { useAdminAction } from './use-admin-action.ts';
import {
  reviewBlockers,
  type ReviewActionHint,
} from './review-prerequisites.ts';

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
    [checked, setChecked] = useState(false),
    [reviewNote, setReviewNote] = useState('');
  const [readError, setReadError] = useState<string>(),
    [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const hintId = useId();
  // A new version invalidates both the draft and the user's previous proof acknowledgment.
  const accept = (next: SubmissionDetail) => {
    setDetail(next);
    setDraft(draftOf(next.submission));
    setReviewNote(next.submission.reviewNote);
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
        if (classifyAccessFailure(failure) === 'expired') onAccessLost();
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
  useAdminDraft(
    !!detail &&
      !!draft &&
      (draft.itemId !== (detail.submission.itemId ?? 0) ||
        draft.collectorName.trim() !== detail.submission.collectorName ||
        draft.collectedOn !== detail.submission.collectedOn ||
        draft.hardcore !== detail.submission.hardcore ||
        reviewNote.trim() !== detail.submission.reviewNote ||
        !!draft.reason),
    action.busy,
  );
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
  const activeItem = catalog.items.some((item) => item.id === row.itemId);
  const draftItemActive = catalog.items.some(
    (item) => item.id === draft.itemId,
  );
  const claimDirty =
    draft.itemId !== (row.itemId ?? 0) ||
    draft.collectorName.trim() !== row.collectorName ||
    draft.collectedOn !== row.collectedOn ||
    draft.hardcore !== row.hardcore;
  const noteDirty = reviewNote.trim() !== row.reviewNote;
  const locked = action.busy || disabled || Boolean(readError),
    proof =
      safeProof(row.proofUrl) ||
      safeScreenshotPath(row.screenshotPath) ||
      (row.source === 'runelite' && Boolean(row.chatMessage?.trim()));
  const change = (fields: Partial<Correction>) => {
    setDraft({ ...draft, ...fields });
    setChecked(false);
  };
  // Save corrections before approval so the acknowledgment refers to persisted claim fields.
  const perform = (decision?: 'approve' | 'reject' | 'revoke') => {
    void action.execute(
      async (signal) => {
        if (
          decision === 'approve' &&
          (claimDirty ||
            !checked ||
            (!proof && row.source !== 'manual') ||
            !activeItem)
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
      },
      reload,
      decision ?? 'claim',
    );
  };
  const saveNote = () => {
    void action.execute(
      async (signal) => {
        if (!noteDirty) return;
        const next = await client.saveReviewNote(
          id,
          row.version,
          reviewNote.trim(),
          session.csrfToken,
          signal,
        );
        if (signal.aborted) return;
        setDetail({ ...detail, submission: next });
        setReviewNote(next.reviewNote);
        setChecked(false);
        action.setMessage('Review note saved.');
        onChanged(next.status);
        // Preserve draft corrections while reloading the updated audit history.
        try {
          const latest = await client.detail(id, signal);
          if (!signal.aborted) {
            setDetail(latest);
            setReviewNote(latest.submission.reviewNote);
            setReadError(undefined);
          }
        } catch (failure) {
          if (classifyAccessFailure(failure) === 'expired') throw failure;
          if (!signal.aborted)
            setReadError(
              'The note was saved, but audit history could not be refreshed. Reload before continuing.',
            );
        }
      },
      reload,
      'note',
    );
  };
  const blockers = reviewBlockers({
    status: row.status,
    requestBusy: action.busy,
    queueUnavailable: disabled,
    readError: Boolean(readError),
    claimDirty,
    noteDirty,
    activeItem,
    draftItemActive,
    validProof: Boolean(proof) || row.source === 'manual',
    acknowledged: checked,
    reasonProvided: Boolean(draft.reason.trim()),
  });
  const describedBy = (key: ReviewActionHint) =>
    blockers[key] ? `review-${hintId}-${key}` : undefined;
  const explanations = (keys: ReviewActionHint[]) =>
    keys
      .filter((key) => blockers[key])
      .map((key) => (
        <p
          className="admin-note admin-action-explanation"
          id={`review-${hintId}-${key}`}
          key={key}
        >
          {blockers[key]}
        </p>
      ));
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
              : row.source === 'runelite'
                ? 'RuneLite submission'
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
            <ProofLink
              url={row.proofUrl}
              source={row.source}
              screenshot={row.screenshotPath}
              previewScreenshot={row.previewScreenshot}
              chatMessage={row.chatMessage}
            />
          </dd>
        </div>
      </dl>
      {row.chatMessage && (
        <div className="submission-chat-proof">
          <strong>Chat message</strong>
          <p>{row.chatMessage}</p>
        </div>
      )}
      {action.busy && (
        <p role="status" className="admin-note">
          {action.operation === 'approve'
            ? 'Approving saved claim…'
            : action.operation === 'reject'
              ? 'Rejecting submission…'
              : action.operation === 'revoke'
                ? 'Revoking credit…'
                : action.operation === 'note'
                  ? 'Saving review note…'
                  : 'Saving claim corrections…'}
        </p>
      )}
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
        {row.itemId !== null && !activeItem && (
          <p className="admin-note">
            Item #{row.itemId} is no longer in the active catalog. Select and
            save an active item before approving this claim. Its proof and
            review history remain available.
          </p>
        )}
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
                className="catalog-choice-list"
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
            Review note
            <textarea
              maxLength={1000}
              rows={3}
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
            />
            <span className="admin-note">
              Saved staff note, separate from claim corrections and decision
              reasons. Clear and save to remove the note.
            </span>
          </label>
          <div className="admin-actions">
            <button
              className="site-button"
              type="button"
              disabled={Boolean(blockers.note)}
              aria-describedby={describedBy('note')}
              aria-busy={action.busy && action.operation === 'note'}
              onClick={saveNote}
            >
              Save review note
            </button>
            <button
              className="site-button"
              type="button"
              disabled={Boolean(blockers.discardNote)}
              aria-describedby={describedBy('discardNote')}
              onClick={() => setReviewNote(row.reviewNote)}
            >
              Discard review note
            </button>
          </div>
          {explanations(['note', 'discardNote'])}
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
              One-time audit reason for rejection, revocation and corrections to
              approved credits. Not saved as a lasting comment.
            </span>
          </label>
          <div className="admin-actions">
            <button
              className="site-button"
              type="submit"
              disabled={Boolean(blockers.claim)}
              aria-describedby={describedBy('claim')}
              aria-busy={action.busy && action.operation === 'claim'}
            >
              Save corrections
            </button>
            <button
              className="site-button"
              type="button"
              disabled={Boolean(blockers.discardClaim)}
              aria-describedby={describedBy('discardClaim')}
              onClick={() => {
                setDraft(draftOf(row));
                setChecked(false);
              }}
            >
              Discard corrections
            </button>
          </div>
          {explanations(['claim', 'discardClaim'])}
        </fieldset>
        {claimDirty && (
          <p className="admin-note">
            Save or discard corrections before deciding on this claim.
          </p>
        )}
        {row.status === 'pending' && (
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={checked}
              disabled={Boolean(blockers.acknowledge)}
              aria-describedby={describedBy('acknowledge')}
              onChange={(event) => setChecked(event.target.checked)}
            />
            {row.source === 'manual'
              ? 'I verified this manual claim and its item, collector, date and world.'
              : row.chatMessage
                ? 'I checked the chat message and any attached proof for the saved item, collector, date and hardcore claim.'
                : 'I checked the linked proof for the saved item, collector, date and hardcore claim.'}
          </label>
        )}
        {row.status === 'pending' && explanations(['acknowledge'])}
        <div className="admin-actions">
          {row.status === 'pending' && (
            <>
              <button
                className="site-button site-button--approve"
                type="button"
                disabled={Boolean(blockers.approve)}
                aria-describedby={describedBy('approve')}
                aria-busy={action.busy && action.operation === 'approve'}
                onClick={() => perform('approve')}
              >
                Approve submission
              </button>
              <button
                className="site-button"
                type="button"
                disabled={Boolean(blockers.reject)}
                aria-describedby={describedBy('reject')}
                aria-busy={action.busy && action.operation === 'reject'}
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
              disabled={Boolean(blockers.revoke)}
              aria-describedby={describedBy('revoke')}
              aria-busy={action.busy && action.operation === 'revoke'}
              onClick={() => perform('revoke')}
            >
              Revoke credit
            </button>
          )}
        </div>
        {row.status === 'pending'
          ? explanations(['approve', 'reject'])
          : row.status === 'approved'
            ? explanations(['revoke'])
            : null}
      </form>
      <ReviewAuditHistory
        key={
          detail.auditRevision +
          ':' +
          row.version +
          ':' +
          refresh +
          ':' +
          detail.audit[0]?.id
        }
        initial={detail}
        client={client}
        disabled={action.busy}
        onAccessLost={onAccessLost}
        onReload={() => setRefresh((v) => v + 1)}
      />
    </section>
  );
}

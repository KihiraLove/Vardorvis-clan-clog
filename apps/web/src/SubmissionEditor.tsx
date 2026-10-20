/** Review saved claims, stage corrections separately and display before/after audit history. */
import { useEffect, useId, useRef, useState } from 'react';
import { collectionTypeLabel } from '@clog/domain';
import { useAdminDraft } from './admin-route-data.ts';
import { classifyAccessFailure } from './admin-session.ts';
import {
  safeScreenshotPath,
  dateSourceLabel,
  validateCorrection,
  type AdminCatalog,
  type AdminClient,
  type Correction,
  type CollectionFlags,
  type Submission,
  type SubmissionDetail,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { formatUtcTime } from './format-time.ts';
import { ReviewAuditHistory } from './ReviewAuditHistory.tsx';
import { ProofLink } from './AdminProofLink.tsx';
import { useAdminAction } from './use-admin-action.ts';
import {
  reviewBlockers,
  unsavedClaimHint,
  type ReviewActionHint,
} from './review-prerequisites.ts';

const hiddenHints = new Set([
  'Only pending or approved claims can be edited.',
  unsavedClaimHint,
  'No review note changes to save.',
  'There are no review note changes to discard.',
  'No claim corrections to save.',
  'There are no claim corrections to discard.',
  'Check the saved item, collector, date, world mode and proof, then tick the proof acknowledgement.',
  'Enter a reason before rejecting a submission.',
  'Enter a reason before revoking a credit.',
]);

const usesSavedTiming = (row: Submission) =>
  row.source !== 'manual' &&
  row.collectionReason !== 'staff_correction' &&
  !(row.collectionReason === 'legacy' && row.itemId !== null);
type ClaimDraft = Pick<
  Correction,
  'itemId' | 'collectorName' | 'collectedOn' | 'reason'
>;
const draftOf = (row: Submission): ClaimDraft => ({
  itemId: row.itemId ?? 0,
  collectorName: row.collectorName,
  collectedOn: row.collectedOn,
  reason: '',
});
const flagsOf = (row: Submission): CollectionFlags => ({
  hardcore: row.hardcore,
  collectionType: row.collectionType ?? 'regular',
});
function ReviewWindow({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="submission-review-dialog"
      aria-label="Submission review"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
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
    [draft, setDraft] = useState<ClaimDraft>();
  const [flags, setFlags] = useState<CollectionFlags>();
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
    setFlags(flagsOf(next.submission));
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
  const flagsDirty =
    !!detail &&
    !!flags &&
    (flags.hardcore !== detail.submission.hardcore ||
      flags.collectionType !==
        (detail.submission.collectionType ?? 'regular') ||
      flags.useIntakeTiming === true);
  const dirty =
    !!detail &&
    !!draft &&
    (draft.itemId !== (detail.submission.itemId ?? 0) ||
      draft.collectorName.trim() !== detail.submission.collectorName ||
      draft.collectedOn !== detail.submission.collectedOn ||
      flagsDirty ||
      reviewNote.trim() !== detail.submission.reviewNote ||
      !!draft.reason);
  useAdminDraft(dirty, action.busy);
  const close = () => {
    if (action.busy) return;
    if (dirty && !window.confirm('Discard unsaved review changes?')) return;
    onClose();
  };
  if (!detail || !draft || !flags)
    return (
      <ReviewWindow onClose={close}>
        <section className="admin-panel">
          <button
            className="site-button review-close"
            aria-label="Close review"
            onClick={close}
          >
            ×
          </button>
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
      </ReviewWindow>
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
    draft.collectedOn !== row.collectedOn;
  const noteDirty = reviewNote.trim() !== row.reviewNote;
  const locked = action.busy || disabled || Boolean(readError),
    proof =
      safeScreenshotPath(row.screenshotPath) ||
      (row.source === 'runelite' && Boolean(row.chatMessage?.trim()));
  const change = (fields: Partial<ClaimDraft>) => {
    setDraft({ ...draft, ...fields });
    setChecked(false);
  };
  const changeFlags = (next: CollectionFlags) => {
    setFlags(next);
    setChecked(false);
  };
  const refreshAudit = async (next: Submission, signal: AbortSignal) => {
    try {
      const latest = await client.detail(id, signal);
      if (signal.aborted) return;
      if (latest.submission.version !== next.version)
        throw new Error('Submission changed again.');
      setDetail(latest);
    } catch (failure) {
      if (classifyAccessFailure(failure) === 'expired') throw failure;
      if (!signal.aborted)
        setReadError(
          'The change was saved, but the latest revision or audit could not be confirmed. Reload before continuing.',
        );
    }
  };
  // Save corrections before approval so the acknowledgment refers to persisted claim fields.
  const perform = (decision?: 'approve' | 'reject' | 'revoke') => {
    void action.execute(
      async (signal) => {
        if (decision && claimDirty) throw new Error(unsavedClaimHint);
        if (decision === 'revoke' && flagsDirty)
          throw new Error('Save or discard collection flags before revoking.');
        if (
          decision === 'approve' &&
          (claimDirty ||
            !checked ||
            (!proof && row.source !== 'manual') ||
            !activeItem)
        )
          throw new Error(
            'Save a specific item match and check the screenshot before approving.',
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
              flagsDirty ? flags : undefined,
            )
          : await client.edit(
              id,
              row.version,
              validateCorrection(
                {
                  ...draft,
                  hardcore: row.hardcore,
                  ...(!usesSavedTiming(row)
                    ? { collectionType: row.collectionType ?? 'regular' }
                    : {}),
                  useIntakeTiming: usesSavedTiming(row),
                },
                catalog,
              ),
              session.csrfToken,
              signal,
            );
        if (signal.aborted) return;
        setDetail({ ...detail, submission: next });
        setDraft(draftOf(next));
        if (decision || !flagsDirty) setFlags(flagsOf(next));
        if (!noteDirty) setReviewNote(next.reviewNote);
        setChecked(false);
        action.setMessage(
          decision
            ? 'Submission ' +
                next.status +
                '. Public credit follows this saved decision.'
            : 'Changes saved. Review the saved claim before approving.',
        );
        onChanged(next.status);
        await refreshAudit(next, signal);
      },
      reload,
      decision ?? 'claim',
    );
  };
  const saveFlags = () => {
    void action.execute(
      async (signal) => {
        if (row.status !== 'approved' || !flagsDirty || !draft.reason.trim())
          throw new Error(
            'Enter an audit reason before saving collection flags.',
          );
        const next = await client.saveCollectionFlags(
          id,
          row.version,
          flags,
          draft.reason.trim(),
          session.csrfToken,
          signal,
        );
        if (signal.aborted) return;
        setDetail({ ...detail, submission: next });
        setFlags(flagsOf(next));
        if (!claimDirty) setDraft({ ...draft, reason: '' });
        setChecked(false);
        action.setMessage('Collection flags saved.');
        onChanged(next.status);
        await refreshAudit(next, signal);
      },
      async () => {
        setReadError(
          'The submission changed. Your local drafts are retained; reload the submission before continuing.',
        );
      },
      'flags',
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
  if (row.status === 'approved' && flagsDirty && !blockers.revoke)
    blockers.revoke = 'Save or discard collection flags before revoking.';
  const showClaimHint = editable && claimDirty;
  const claimHintId = `review-${hintId}-claim-draft`;
  const shownHint = (key: ReviewActionHint) =>
    blockers[key] && !hiddenHints.has(blockers[key]);
  const describedBy = (key: ReviewActionHint) =>
    showClaimHint && blockers[key] === unsavedClaimHint
      ? claimHintId
      : shownHint(key)
        ? `review-${hintId}-${key}`
        : undefined;
  const explanations = (keys: ReviewActionHint[]) =>
    keys.filter(shownHint).map((key) => (
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
    <ReviewWindow onClose={close}>
      <section
        className="admin-panel submission-editor"
        aria-labelledby="submission-title"
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="submission-title">
              {catalog.items.find((item) => item.id === row.itemId)?.name ??
                row.rawItemText ??
                'Unmatched item'}{' '}
              · {row.collectorName}
            </h2>
            <p className="admin-note">Revision: {row.version}</p>
            <p>
              {row.status} ·{' '}
              {row.source === 'manual'
                ? 'Manual submission'
                : row.source === 'runelite'
                  ? 'RuneLite submission'
                  : 'Discord submission'}{' '}
              {row.id}
            </p>
          </div>
          <button
            className="site-button review-close"
            aria-label="Close review"
            disabled={action.busy}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="submission-review-layout">
          <div className="submission-review-evidence">
            <h3>Submission details</h3>
            <dl className="submission-facts">
              <div>
                <dt>Collection type</dt>
                <dd>{collectionTypeLabel(row.collectionType)}</dd>
              </div>
              <div>
                <dt>
                  {row.source === 'runelite'
                    ? 'Submitted item name'
                    : 'Raw item input'}
                </dt>
                <dd>{row.rawItemText || 'No raw text supplied'}</dd>
              </div>
              {row.gameItemId !== undefined && (
                <div>
                  <dt>Game item ID</dt>
                  <dd>{row.gameItemId}</dd>
                </div>
              )}
              {row.itemId === null && (
                <div>
                  <dt>Catalog match</dt>
                  <dd>Unmatched</dd>
                </div>
              )}
              <div>
                <dt>Date source</dt>
                <dd>{dateSourceLabel(row.dateSource)}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{formatUtcTime(row.submittedAt)}</dd>
              </div>
              <div>
                <dt>Collected on</dt>
                <dd>{row.collectedOn}</dd>
              </div>
              <div>
                <dt>Worlds</dt>
                <dd>{row.hardcore ? 'Hardcore worlds' : 'Ordinary worlds'}</dd>
              </div>
              <div>
                <dt>Proof</dt>
                <dd>
                  <ProofLink
                    source={row.source}
                    screenshot={row.screenshotPath}
                    chatMessage={row.chatMessage}
                  />
                </dd>
              </div>
              {selected && (
                <>
                  <div>
                    <dt>Canonical item</dt>
                    <dd>#{selected.id}</dd>
                  </div>
                  <div>
                    <dt>Item origin</dt>
                    <dd>
                      {selected.origin === 'manual'
                        ? 'Manual item'
                        : 'Source item'}
                    </dd>
                  </div>
                  <div>
                    <dt>Collection log pages</dt>
                    <dd>
                      {catalog.pages
                        .filter((page) => page.itemIds.includes(selected.id))
                        .map((page) => page.name)
                        .join(', ') || 'Not on a page'}
                    </dd>
                  </div>
                </>
              )}
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
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              perform();
            }}
          >
            {row.itemId !== null && !activeItem && (
              <p className="admin-note">
                Item #{row.itemId} is no longer in the active catalog. Select
                and save an active item before approving this claim. Its proof
                and review history remain available.
              </p>
            )}
            <fieldset disabled={locked || !editable} className="admin-fieldset">
              <legend>Saved claim and corrections</legend>
              <div className="admin-form-grid review-claim-columns">
                <div>
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
                <div>
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
                </div>
              </div>
              {!matches.length && (
                <p className="admin-note">
                  No matching items. Add a missing item in Catalog items before
                  resolving this submission.
                </p>
              )}
              <label>
                Review note (optional)
                <textarea
                  maxLength={1000}
                  rows={3}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                />
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
                Review reason (optional) / Rejection reason / Revoke reason
                <textarea
                  maxLength={1000}
                  rows={3}
                  value={draft.reason}
                  onChange={(event) =>
                    setDraft({ ...draft, reason: event.target.value })
                  }
                />
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
            <fieldset
              disabled={locked || !editable}
              className="admin-fieldset review-collection-flags"
            >
              <legend>Collection flags</legend>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={flags.hardcore}
                  onChange={(event) =>
                    changeFlags({
                      hardcore: event.target.checked,
                      collectionType: 'regular',
                    })
                  }
                />
                Collected on hardcore worlds
              </label>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  disabled={flags.hardcore}
                  checked={
                    !flags.hardcore &&
                    (flags.collectionType ?? row.collectionType) === 'event'
                  }
                  onChange={(event) =>
                    changeFlags({
                      hardcore: flags.hardcore,
                      collectionType: event.target.checked
                        ? 'event'
                        : 'regular',
                    })
                  }
                />
                Obtained during events
              </label>
              {row.source !== 'manual' && (
                <button
                  className="site-button"
                  type="button"
                  disabled={flags.useIntakeTiming === true}
                  onClick={() =>
                    changeFlags({
                      hardcore: flags.hardcore,
                      useIntakeTiming: true,
                    })
                  }
                >
                  Use saved intake timing
                </button>
              )}
              {flags.useIntakeTiming && (
                <p className="admin-note">
                  Saved intake timing will determine the collection type.
                </p>
              )}
              {row.status === 'pending' && flagsDirty && (
                <p className="admin-note">
                  Collection flags will be saved with your review decision.
                </p>
              )}
              <div className="admin-actions">
                {row.status === 'approved' && (
                  <button
                    className="site-button"
                    type="button"
                    disabled={
                      locked ||
                      !activeItem ||
                      !flagsDirty ||
                      !draft.reason.trim()
                    }
                    aria-busy={action.busy && action.operation === 'flags'}
                    onClick={saveFlags}
                  >
                    Save collection flags
                  </button>
                )}
                <button
                  className="site-button"
                  type="button"
                  disabled={!flagsDirty}
                  onClick={() => changeFlags(flagsOf(row))}
                >
                  Discard collection flags
                </button>
              </div>
              {row.status === 'approved' &&
                flagsDirty &&
                !draft.reason.trim() && (
                  <p className="admin-note">
                    Enter an audit reason before saving collection flags.
                  </p>
                )}
            </fieldset>
            {showClaimHint && (
              <p className="admin-note" id={claimHintId}>
                {unsavedClaimHint}
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
                    : 'I checked the screenshot for the saved item, collector, date and hardcore claim.'}
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
        </div>
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
    </ReviewWindow>
  );
}

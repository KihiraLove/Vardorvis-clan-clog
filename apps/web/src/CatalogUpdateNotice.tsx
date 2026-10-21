/** Administrator review of pending release changes, grouped by repair. */
import { useEffect, useRef, useState } from 'react';
import type {
  CatalogUpdateReview,
  CatalogUpdateSelection,
  CatalogUpdateProposal,
} from '@clog/domain';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { classifyAccessFailure } from './admin-session.ts';
import { useAdminDraft } from './admin-route-data.ts';
import {
  groupedCatalogReview,
  selectedCatalogProposals,
  type CatalogUpdateGroup,
} from './catalog-update-groups.ts';

function problem(p: CatalogUpdateProposal) {
  switch (p.kind) {
    case 'createPage':
      return `${p.label}: page is missing.`;
    case 'createItem':
      return `${p.label}: item is missing (game IDs ${p.after}).`;
    case 'addGameId':
      return `${p.label}: missing game ID ${p.after}.`;
    case 'removeGameId':
      return `${p.label}: remove local game ID ${p.before}.`;
    case 'addLink':
      return `${p.label}: missing relationship to ${p.afterLabel ?? p.after}.`;
    case 'removeLink':
      return `${p.label}: remove relationship to ${p.beforeLabel ?? p.before}.`;
    case 'adopt':
      return `${p.label}: confirm the matching existing ${p.before === 'Unlinked local page' ? 'page' : 'item'}.`;
    case 'pageCategory':
      return `${p.label}: page section ${p.before} → ${p.after}.`;
    default:
      return `${p.label}: ${p.before || 'Missing'} → ${p.after || 'Remove'}.`;
  }
}
export function CatalogUpdateNotice({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [review, setReview] = useState<CatalogUpdateReview>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [groups, setGroups] = useState<Set<CatalogUpdateGroup>>(new Set());
  const [icons, setIcons] = useState(false);
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const autoPrompt = useRef('');
  const operation = useRef<AbortController | undefined>(undefined);
  const retry = useRef({ payload: '', key: '' });
  useAdminDraft(false, busy || uncertain);
  const reset = () => {
    setGroups(new Set());
    setIcons(false);
    setIdentities({});
  };
  const fail = (failure: unknown) => {
    if (classifyAccessFailure(failure) === 'expired') onAccessLost();
    else
      setError(
        failure instanceof Error
          ? failure.message
          : 'Catalog update review could not be loaded.',
      );
  };
  const load = async (signal: AbortSignal) => {
    const next = await (
      await client.catalogUpdateClient!()
    ).catalogUpdates(signal);
    if (!signal.aborted) setReview(next);
    return next;
  };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    void load(controller.signal)
      .then(() => {
        if (active) {
          reset();
          setError(undefined);
        }
      })
      .catch((e) => {
        if (!active) return;
        if (controller.signal.aborted)
          setError('Catalog update review timed out. Retry catalog updates.');
        else fail(e);
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
  }, [client, session.username, refresh]);
  useEffect(() => {
    const update = () => {
      if (!busy && !uncertain) setRefresh((n) => n + 1);
    };
    window.addEventListener('catalog-updated', update);
    window.addEventListener('catalog-review-refresh', update);
    return () => {
      window.removeEventListener('catalog-updated', update);
      window.removeEventListener('catalog-review-refresh', update);
    };
  }, [busy, uncertain]);
  useEffect(() => () => operation.current?.abort(), []);
  const pending =
    !!review && !!(review.proposals.length || review.conflicts.length);
  useEffect(() => {
    if (pending && review?.autoOpen && autoPrompt.current !== review.revision) {
      autoPrompt.current = review.revision;
      restore.current = document.activeElement as HTMLElement;
      setOpen(true);
    }
  }, [review, pending]);
  useEffect(() => {
    if (!open || !review) return;
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    void client.catalogUpdateClient!()
      .then((api) =>
        api.catalogUpdateSeen(
          review.revision,
          session.csrfToken,
          controller.signal,
        ),
      )
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      element?.close();
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, review?.revision]);
  const restoreFocus = () => {
    if (restore.current?.isConnected && restore.current !== document.body)
      restore.current.focus();
    else
      (
        button.current ?? document.querySelector<HTMLElement>('a[href="/"]')
      )?.focus();
  };
  const finishClose = () => {
    setOpen(false);
    requestAnimationFrame(restoreFocus);
  };
  const cancel = () => {
    if (!busy && !uncertain) {
      reset();
      finishClose();
    }
  };
  const apply = review
    ? selectedCatalogProposals(review, groups, icons, identities)
    : [];
  const missingIdentity = !!review?.pageMatches?.some(
    (m) =>
      groups.has('pages') &&
      review.proposals.some(
        (p) =>
          p.entityKey === m.entityKey &&
          ['adoptPage', 'createPage'].includes(p.kind),
      ) &&
      !identities[m.entityKey],
  );
  const save = async () => {
    if (!review || busy || !apply.length || missingIdentity) return;
    const controller = new AbortController();
    operation.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const selection: CatalogUpdateSelection = {
      revision: review.revision,
      catalogRevision: review.catalogRevision,
      apply,
      keep: [],
    };
    const payload = JSON.stringify(selection);
    if (retry.current.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    setError(undefined);
    let saved = false;
    try {
      await (
        await client.catalogUpdateClient!()
      ).applyCatalogUpdate(
        selection,
        retry.current.key,
        session.csrfToken,
        controller.signal,
      );
      saved = true;
      retry.current = { payload: '', key: '' };
      setUncertain(false);
      reset();
      finishClose();
      await load(controller.signal);
      requestAnimationFrame(restoreFocus);
      window.dispatchEvent(new Event('catalog-updated'));
    } catch (failure) {
      const status =
        failure instanceof Error && 'status' in failure
          ? failure.status
          : undefined;
      if (saved) {
        setError(
          'Changes saved, but the updated review could not be loaded. Retry catalog updates.',
        );
      } else if (status === 409) {
        retry.current = { payload: '', key: '' };
        setUncertain(false);
        reset();
        try {
          await load(controller.signal);
        } catch {
          setLoading(true);
          setError(
            'The catalog changed, but refreshing failed. Cancel and retry catalog updates.',
          );
          return;
        }
        setError(
          'The catalog changed. Review the refreshed problems and choose your fixes again.',
        );
      } else if (
        status === 401 ||
        status === 403 ||
        status === 422 ||
        status === 400
      ) {
        setUncertain(false);
        fail(failure);
      } else {
        setUncertain(true);
        setError(
          'Save could not be confirmed. Click Save to retry the same choices and recover its receipt.',
        );
      }
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };
  if (!pending && !error && !open) return null;
  return (
    <section className="catalog-update-notice" aria-label="Catalog updates">
      {pending && (
        <button
          ref={button}
          className="site-button"
          onClick={() => {
            restore.current = document.activeElement as HTMLElement;
            setOpen(true);
          }}
        >
          Review catalog update (
          {review!.proposals.length + review!.conflicts.length})
        </button>
      )}
      {error && !open && (
        <p role="alert">
          {error}{' '}
          <button
            className="site-button"
            onClick={() => setRefresh((n) => n + 1)}
          >
            Retry catalog updates
          </button>
        </p>
      )}
      {open && review && (
        <dialog
          ref={dialog}
          className="catalog-update-dialog"
          aria-labelledby="catalog-update-title"
          onCancel={(e) => {
            e.preventDefault();
            cancel();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Tab') return;
            const controls = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]',
              ),
            ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length);
            const first = controls[0],
              last = controls.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }}
        >
          <h2 id="catalog-update-title">Catalog update available</h2>
          <p>
            Choose the groups to fix. Unchecked groups keep their current values
            and remain available for later review.
          </p>
          <fieldset
            className="admin-fieldset"
            disabled={busy || loading || uncertain}
          >
            {groupedCatalogReview(review).length > 0 && (
              <table className="catalog-update-table">
                <thead>
                  <tr>
                    <th scope="col">Detected problem</th>
                    <th scope="col">Fix?</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedCatalogReview(review).map((group) => (
                    <tr key={group.key}>
                      <td>
                        <h3>{group.title}</h3>
                        <ul>
                          {group.proposals
                            .filter(
                              (p) =>
                                !(
                                  ['adoptPage', 'createPage'].includes(
                                    p.kind,
                                  ) &&
                                  review.pageMatches?.some(
                                    (m) => m.entityKey === p.entityKey,
                                  )
                                ),
                            )
                            .map((p) => (
                              <li key={p.id}>{problem(p)}</li>
                            ))}
                        </ul>
                        {group.conflicts.map((c) => (
                          <p key={c.kind + c.entityKey}>
                            <strong>{c.label}</strong>: {c.reason}{' '}
                            {c.candidates
                              .map((p) => `${p.name} (#${p.id})`)
                              .join(', ')}
                          </p>
                        ))}
                        {group.key === 'pages' &&
                          review.pageMatches?.map((m) => (
                            <div key={m.entityKey}>
                              <label>
                                Page identity for {m.label}
                                <select
                                  value={identities[m.entityKey] ?? ''}
                                  onChange={(e) =>
                                    setIdentities((old) => ({
                                      ...old,
                                      [m.entityKey]: e.target.value,
                                    }))
                                  }
                                >
                                  <option value="">
                                    Choose an existing page or a separate page
                                  </option>
                                  {review.proposals
                                    .filter(
                                      (p) =>
                                        p.entityKey === m.entityKey &&
                                        ['adoptPage', 'createPage'].includes(
                                          p.kind,
                                        ),
                                    )
                                    .map((p) => (
                                      <option value={p.id} key={p.id}>
                                        {p.kind === 'createPage'
                                          ? 'Create separate page: ' + m.label
                                          : 'Adopt ' + p.label}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              {m.candidates.map((p) => (
                                <p key={p.id}>
                                  {p.name} ({p.id}, {p.category})
                                  {!p.active && ' — retired'}. Matching items:{' '}
                                  {p.matchedItems.join(', ') || 'None'}.
                                  Missing: {p.missingItems.join(', ') || 'None'}
                                  . Extra: {p.extraItems.join(', ') || 'None'}.
                                </p>
                              ))}
                            </div>
                          ))}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'Fix ' + group.title}
                          checked={groups.has(group.key)}
                          disabled={!group.proposals.length}
                          onChange={(e) =>
                            setGroups((old) => {
                              const next = new Set(old);
                              if (e.target.checked) next.add(group.key);
                              else next.delete(group.key);
                              return next;
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {review.proposals.some((p) => p.kind === 'image') && (
              <label className="admin-checkbox catalog-update-icons">
                <input
                  type="checkbox"
                  checked={icons}
                  onChange={(e) => setIcons(e.target.checked)}
                />
                Use project supplied item icons (recommended)
              </label>
            )}
          </fieldset>
          {!pending && <p>No catalog corrections are pending.</p>}
          {missingIdentity && (
            <p role="status">
              Choose the page identity before saving Missing pages.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="admin-actions">
            <button
              className="site-button"
              disabled={busy || loading || !apply.length || missingIdentity}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              className="site-button"
              disabled={busy || uncertain}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}

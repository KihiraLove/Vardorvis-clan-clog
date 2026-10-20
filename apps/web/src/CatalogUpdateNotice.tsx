/** One durable update prompt, with an always-available way to revisit the review. */
import { useEffect, useRef, useState } from 'react';
import type {
  CatalogUpdateReview,
  CatalogUpdateProposal,
  CatalogUpdateSelection,
} from '@clog/domain';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { classifyAccessFailure } from './admin-session.ts';
import { useAdminDraft } from './admin-route-data.ts';

const labels: Record<CatalogUpdateProposal['kind'], string> = {
  name: 'Item name',
  gameIds: 'Game item IDs',
  addGameId: 'Add game item ID',
  removeGameId: 'Remove local game item ID',
  image: 'Supplied image',
  pageName: 'Page name',
  pageCategory: 'Page section',
  addLink: 'Add to page',
  removeLink: 'Remove local page association',
  adopt: 'Confirm local identity',
  adoptPage: 'Adopt existing page',
  createPage: 'Create separate supplied page',
};
const proposalLabel = (p: CatalogUpdateProposal) =>
  labels[p.kind] +
  (p.kind === 'addGameId'
    ? ' ' + p.after
    : p.kind === 'removeGameId'
      ? ' ' + p.before
      : '');
export function CatalogUpdateNotice({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [review, setReview] = useState<CatalogUpdateReview>(),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState('');
  const [choices, setChoices] = useState<Record<string, 'apply' | 'keep'>>({});
  useAdminDraft(false, busy);
  const dialog = useRef<HTMLDialogElement>(null),
    op = useRef<AbortController | undefined>(undefined),
    button = useRef<HTMLButtonElement>(null),
    restore = useRef<HTMLElement | null>(null),
    autoPrompt = useRef(''),
    retry = useRef({ payload: '', key: '' });
  const fail = (error: unknown) => {
    if (classifyAccessFailure(error) === 'expired') onAccessLost();
    else
      setError(
        error instanceof Error
          ? error.message
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
    op.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    void load(controller.signal)
      .catch((e) => {
        if (!active) return;
        if (controller.signal.aborted)
          setError('Catalog update review timed out. Retry catalog updates.');
        else fail(e);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      op.current?.abort();
    };
  }, [client, session.username]); // The component is mounted only for the administrator.
  useEffect(() => {
    if (review?.autoOpen && autoPrompt.current !== review.revision) {
      autoPrompt.current = review.revision;
      restore.current = document.activeElement as HTMLElement;
      setOpen(true);
    }
  }, [review]);
  useEffect(() => {
    if (!open || !review) return;
    const element = dialog.current;
    element?.showModal();
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
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
    };
  }, [open, review?.revision]);
  const close = () => {
    if (busy) return;
    setOpen(false);
    requestAnimationFrame(() => {
      if (restore.current?.isConnected && restore.current !== document.body)
        restore.current.focus();
      else button.current?.focus();
    });
  };
  const execute = async (mode: 'save' | 'reload' | 'rescan') => {
    if (busy) return;
    const controller = new AbortController();
    op.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (mode === 'save' && review) {
        const selection: CatalogUpdateSelection = {
          revision: review.revision,
          catalogRevision: review.catalogRevision,
          apply: Object.keys(choices)
            .filter((k) => choices[k] === 'apply')
            .sort(),
          keep: Object.keys(choices)
            .filter((k) => choices[k] === 'keep')
            .sort(),
        };
        const payload = JSON.stringify(selection);
        if (retry.current.payload !== payload)
          retry.current = { payload, key: crypto.randomUUID() };
        const receipt = await (
          await client.catalogUpdateClient!()
        ).applyCatalogUpdate(
          selection,
          retry.current.key,
          session.csrfToken,
          controller.signal,
        );
        retry.current = { payload: '', key: '' };
        setChoices({});
        setMessage(
          receipt.applied + ' changes applied; ' + receipt.kept + ' kept.',
        );
        window.dispatchEvent(new Event('catalog-updated'));
      }
      if (mode === 'rescan' && review) {
        const payload =
          'rescan:' + review.revision + ':' + review.catalogRevision;
        if (retry.current.payload !== payload)
          retry.current = { payload, key: crypto.randomUUID() };
        const result = await (
          await client.catalogUpdateClient!()
        ).rescanCatalogUpdate(
          review.revision,
          retry.current.key,
          session.csrfToken,
          controller.signal,
        );
        retry.current = { payload: '', key: '' };
        setMessage(
          result.addedItems.length +
            ' missing items and ' +
            result.addedPages.length +
            ' missing pages added.',
        );
        window.dispatchEvent(new Event('catalog-updated'));
      }
      await load(controller.signal);
      if (mode !== 'save') setChoices({});
    } catch (e) {
      if (controller.signal.aborted)
        setError(
          'Request could not be confirmed. Retry the same choices to recover the saved receipt.',
        );
      else fail(e);
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };
  const visible =
    review?.proposals.filter((p) =>
      (p.label + ' ' + labels[p.kind] + ' ' + p.before + ' ' + p.after)
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  if (!open && !error && !review?.releases.length) return null;
  return (
    <section className="catalog-update-notice" aria-label="Catalog updates">
      {review?.releases.length ? (
        <button
          className="site-button"
          ref={button}
          onClick={() => {
            restore.current = document.activeElement as HTMLElement;
            setOpen(true);
          }}
        >
          Review catalog update (
          {review.proposals.length + review.conflicts.length})
        </button>
      ) : null}
      {error && !open && (
        <p role="alert">
          {error}{' '}
          <button
            className="site-button"
            onClick={() => void execute('reload')}
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
            close();
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
          <div className="catalog-update-heading">
            <h2 id="catalog-update-title">Catalog update available</h2>
            <button
              className="site-button"
              aria-label="Review later and close"
              disabled={busy}
              onClick={close}
            >
              ×
            </button>
          </div>
          <p>
            Missing content was added where identities were unambiguous.
            Existing entries keep their current values until you select a change
            below. Local IDs and collection history stay attached.
          </p>
          <details>
            <summary>Installed content</summary>
            {review.releases.map((r) => (
              <div key={r.id}>
                <h3>{r.title}</h3>
                <p>
                  Added items: {r.addedItems.join(', ') || 'None'}. Added pages:{' '}
                  {r.addedPages.join(', ') || 'None'}.
                </p>
              </div>
            ))}
          </details>
          {review.conflicts.length > 0 && (
            <section aria-label="Identity conflicts">
              <h3>Identity review</h3>
              <p>
                Review page candidates below. Other conflicting entries can be
                corrected in Items catalog, then rescanned.
              </p>
              {review.conflicts.map((c) => (
                <p key={c.kind + ':' + c.entityKey}>
                  <strong>{c.label}</strong>: {c.reason}{' '}
                  {c.candidates
                    .map((v) => v.name + ' (#' + v.id + ')')
                    .join(', ')}
                </p>
              ))}
            </section>
          )}
          {review.pageMatches?.map((match) => (
            <section
              key={match.entityKey}
              aria-label={'Page candidates for ' + match.label}
            >
              <h3>Existing pages for {match.label}</h3>
              <p>
                Choose one existing page to adopt, or explicitly create a
                separate page. Adoption keeps its local key and existing
                memberships.
              </p>
              {match.candidates.map((p) => (
                <article key={p.id} className="catalog-update-proposal">
                  <h4>
                    {p.name} ({p.id})
                  </h4>
                  <p>
                    Section: {p.category}.{' '}
                    {p.active
                      ? 'Active'
                      : 'Retired — resolve in Items catalog first'}
                  </p>
                  <p>Matching items: {p.matchedItems.join(', ') || 'None'}</p>
                  <p>
                    Missing supplied items:{' '}
                    {p.missingItems.join(', ') || 'None'}
                  </p>
                  <p>Extra local items: {p.extraItems.join(', ') || 'None'}</p>
                </article>
              ))}
            </section>
          ))}
          {review.gameIdReviews
            ?.filter((r) => r.localIds.join(',') !== r.suppliedIds.join(','))
            .map((r) => (
              <details key={r.entityKey}>
                <summary>{r.label} — review game item IDs</summary>
                <p>
                  Current IDs, retained unless you select a removal:{' '}
                  {r.localIds.join(', ') || 'None'}
                </p>
                <p>Supplied IDs: {r.suppliedIds.join(', ')}</p>
                <p>
                  Extra local IDs may be valid variants. Keep them unless you
                  identify an incorrect mapping.
                </p>
              </details>
            ))}
          <label className="admin-field-label">
            Search changes
            <input
              className="admin-input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <fieldset className="admin-fieldset" disabled={busy}>
            <div className="admin-actions" aria-label="Bulk choices">
              {(
                [
                  'name',
                  'gameIds',
                  'addGameId',
                  'removeGameId',
                  'image',
                  'pageName',
                  'pageCategory',
                  'addLink',
                  'removeLink',
                  'adopt',
                ] as const
              )
                .filter((k) => visible.some((p) => p.kind === k))
                .map((kind) => (
                  <button
                    className="site-button"
                    type="button"
                    key={kind}
                    onClick={() =>
                      setChoices((old) => ({
                        ...old,
                        ...Object.fromEntries(
                          visible
                            .filter((p) => p.kind === kind)
                            .map((p) => [p.id, 'apply']),
                        ),
                      }))
                    }
                  >
                    Select {labels[kind].toLowerCase()} changes
                  </button>
                ))}
            </div>
            <p className="admin-note">
              Extra local page associations may be intentional. Remove only the
              associations you want to change. Game IDs are added and removed
              individually; unselected local variants are retained.
            </p>
            {visible.map((p) => (
              <article className="catalog-update-proposal" key={p.id}>
                <h3>
                  {p.label} — {proposalLabel(p)}
                </h3>
                <p className="admin-note">
                  Local entry {p.localId}; supplied key {p.entityKey}
                </p>
                {p.kind === 'image' ? (
                  <div className="catalog-update-images">
                    <figure>
                      {p.before ? (
                        <img src={p.before} alt={'Current ' + p.label} />
                      ) : (
                        <span>No current image</span>
                      )}
                      <figcaption>Current</figcaption>
                    </figure>
                    <figure>
                      <img src={p.after} alt={'Supplied ' + p.label} />
                      <figcaption>Supplied</figcaption>
                    </figure>
                  </div>
                ) : (
                  <p>
                    Current: {p.before || 'Not associated'}
                    <br />
                    Supplied: {p.after || 'Remove this association'}
                  </p>
                )}
                <label className="admin-field-label">
                  Decision for {p.label}: {proposalLabel(p)}
                  <select
                    className="admin-input"
                    value={choices[p.id] ?? ''}
                    onChange={(e) =>
                      setChoices((old) => {
                        const next = { ...old };
                        if (
                          e.target.value === 'apply' &&
                          ['adoptPage', 'createPage'].includes(p.kind)
                        )
                          for (const other of review.proposals.filter(
                            (other) =>
                              other.entityKey === p.entityKey &&
                              ['adoptPage', 'createPage'].includes(other.kind),
                          ))
                            if (other.id !== p.id && next[other.id] === 'apply')
                              delete next[other.id];
                        if (e.target.value)
                          next[p.id] = e.target.value as 'apply' | 'keep';
                        else delete next[p.id];
                        return next;
                      })
                    }
                  >
                    <option value="">Review later</option>
                    <option value="apply">Apply this change</option>
                    <option value="keep">Keep current value</option>
                  </select>
                </label>
              </article>
            ))}
            {review.currentImages.some((i) => i.identical) && (
              <details>
                <summary>Already using supplied images</summary>
                {review.currentImages
                  .filter((i) => i.identical)
                  .map((i) => (
                    <p key={i.name}>{i.name} — already using supplied image</p>
                  ))}
              </details>
            )}
            {!review.proposals.length && !review.conflicts.length && (
              <p>No catalog corrections are pending.</p>
            )}
            {message && <p role="status">{message}</p>}
            {error && (
              <p className="admin-error" role="alert">
                {error}
              </p>
            )}
            <div className="admin-actions">
              <button
                className="site-button"
                disabled={!Object.keys(choices).length}
                onClick={() => void execute('save')}
              >
                {busy ? 'Saving…' : 'Apply selected changes'}
              </button>
              <button
                className="site-button"
                onClick={() => void execute('reload')}
              >
                Reload review
              </button>
              <button
                className="site-button"
                onClick={() => void execute('rescan')}
              >
                Rescan missing content
              </button>
              <button className="site-button" onClick={close}>
                Review later
              </button>
            </div>
          </fieldset>
        </dialog>
      )}
    </section>
  );
}

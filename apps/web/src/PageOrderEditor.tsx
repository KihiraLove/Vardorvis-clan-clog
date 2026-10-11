/** Manage one page's memberships and publish complete order drafts against the saved version. */
import { useEffect, useRef, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  moveItem,
  validateOrder,
  type AdminCatalog,
  type AdminClient,
  type AdminPage,
} from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';

export function PageOrderEditor({
  client,
  catalog,
  session,
  onAccessLost,
  refresh,
}: {
  client: AdminClient;
  catalog: AdminCatalog;
  session: AdminSession;
  onAccessLost: () => void;
  refresh: (signal: AbortSignal) => Promise<AdminCatalog>;
}) {
  const initial =
    catalog.pages.find((page) => page.id === 'vardorvis') ?? catalog.pages[0];
  const [pageId, setPageId] = useState(initial?.id ?? ''),
    [saved, setSaved] = useState<AdminPage | undefined>(initial);
  const [ids, setIds] = useState<number[]>(initial?.itemIds ?? []),
    [moved, setMoved] = useState<string>();
  const action = useAdminAction(onAccessLost);
  const seen = useRef(catalog.revision);
  const dirty = JSON.stringify(ids) !== JSON.stringify(saved?.itemIds ?? []);
  const latest = catalog.pages.find((page) => page.id === pageId),
    stale = latest?.version !== saved?.version;
  const accept = (page: AdminPage | undefined) => {
    setSaved(page);
    setIds(page?.itemIds ?? []);
    setMoved(undefined);
  };
  useEffect(() => {
    if (catalog.revision === seen.current) return;
    seen.current = catalog.revision;
    // Preserve an unsaved arrangement on refresh; a changed version blocks saving it.
    if (!dirty) accept(latest);
  }, [catalog.revision, dirty, latest]);
  const move = (from: number, to: number) => {
    if (action.busy || to < 0 || to >= ids.length) return;
    setIds(moveItem(ids, from, to));
    const item = catalog.items.find((item) => item.id === ids[from]);
    setMoved(
      (item?.name ?? 'Item') +
        ' moved to position ' +
        (to + 1) +
        ' of ' +
        ids.length +
        '.',
    );
  };
  return (
    <section
      className="admin-panel page-order-editor"
      aria-labelledby="page-order-title"
    >
      <h2 id="page-order-title">Item management</h2>
      <p>
        Drag an item, use its move buttons, or focus a row and press Alt + ↑ /
        ↓. Save to publish the full arrangement. Delete removes an item from
        this page; deleting its last page removes it from the catalog.
      </p>
      <div className="order-page-picker">
        <label htmlFor="order-page">Collection-log page</label>
        <select
          id="order-page"
          disabled={action.busy || dirty}
          value={pageId}
          onChange={(event) => {
            setPageId(event.target.value);
            accept(
              catalog.pages.find((page) => page.id === event.target.value),
            );
          }}
        >
          {catalog.pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </select>
      </div>
      {saved && (
        <p className="admin-note">
          {saved.itemIds.length} items ·{' '}
          {saved.orderOrigin === 'manual'
            ? 'Manual order override'
            : 'Source order'}{' '}
          · {saved.version}
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
      {moved && (
        <p role="status" className="admin-note">
          {moved}
        </p>
      )}
      {stale && dirty && (
        <div role="alert" className="admin-error">
          <p>
            This page changed. Load its latest membership and order before
            saving.
          </p>
          <button
            className="site-button"
            disabled={action.busy}
            onClick={() => {
              void action.execute(async (signal) => {
                const next = await refresh(signal);
                if (!signal.aborted)
                  accept(next.pages.find((page) => page.id === pageId));
              });
            }}
          >
            Load latest order
          </button>
        </div>
      )}
      <ol className="page-order-list" aria-label="Page items in draft order">
        {ids.map((id, index) => {
          const item = catalog.items.find((item) => item.id === id);
          if (!item)
            return (
              <li key={id}>Item #{id} is unavailable. Reload this page.</li>
            );
          return (
            <li
              key={id}
              data-item-id={id}
              draggable={!action.busy}
              tabIndex={0}
              onKeyDown={(event) => {
                if (
                  event.target !== event.currentTarget ||
                  !event.altKey ||
                  !['ArrowUp', 'ArrowDown'].includes(event.key)
                )
                  return;
                event.preventDefault();
                move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', String(id));
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (!action.busy) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = ids.indexOf(
                  Number(event.dataTransfer.getData('text/plain')),
                );
                if (from >= 0) move(from, index);
              }}
            >
              <span className="order-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <img src={item.iconPath} alt="" />
              <div className="order-item-name">
                <strong>{item.name}</strong>
                <span>
                  #{id} ·{' '}
                  {item.origin === 'manual' ? 'Manual item' : 'Source item'}
                  {item.overrides.length
                    ? ' · ' + item.overrides.join('/') + ' override'
                    : ''}
                </span>
              </div>
              <span className="order-position">{index + 1}</span>
              <div className="order-move-buttons">
                <button
                  type="button"
                  className="site-button"
                  disabled={action.busy || index === 0}
                  aria-label={'Move ' + item.name + ' up'}
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="site-button"
                  disabled={action.busy || index === ids.length - 1}
                  aria-label={'Move ' + item.name + ' down'}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="site-button"
                  disabled={action.busy || dirty || stale || !saved}
                  aria-label={`Delete ${item.name} from ${saved?.name ?? 'this page'}`}
                  onClick={() => {
                    if (!saved || action.busy || dirty || stale) return;
                    const lastPage =
                      catalog.pages.filter((page) => page.itemIds.includes(id))
                        .length === 1;
                    if (
                      !window.confirm(
                        `Are you sure you want to delete ${item.name} from ${saved.name}? ` +
                          (lastPage
                            ? 'This is its last page, so the item will be removed from the catalog. Submission and review history will be preserved.'
                            : 'The item will remain on its other pages.'),
                      )
                    )
                      return;
                    void action.execute(
                      async (signal) => {
                        const { retired } = await client.removePageItem(
                          pageId,
                          id,
                          catalog.revision,
                          saved.version,
                          session.csrfToken,
                          signal,
                        );
                        if (signal.aborted) return;
                        const next = await refresh(signal);
                        if (signal.aborted) return;
                        accept(next.pages.find((page) => page.id === pageId));
                        action.setMessage(
                          retired
                            ? `${item.name} deleted from its last page and the catalog.`
                            : `${item.name} deleted from ${saved.name}. Other pages are unchanged.`,
                        );
                      },
                      async (signal) => {
                        const next = await refresh(signal);
                        if (!signal.aborted)
                          accept(next.pages.find((page) => page.id === pageId));
                      },
                    );
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {!ids.length && <p className="admin-empty">No items on this page.</p>}
      {dirty && (
        <p className="admin-note">
          Unsaved order. Save or discard before switching pages or deleting
          items.
        </p>
      )}
      <div className="admin-actions">
        <button
          className="site-button"
          disabled={action.busy || !dirty || stale || !saved}
          onClick={() => {
            void action.execute(
              async (signal) => {
                validateOrder(saved!.itemIds, ids);
                const page = await client.order(
                  pageId,
                  ids,
                  saved!.version,
                  session.csrfToken,
                  signal,
                );
                if (signal.aborted) return;
                accept(page);
                action.setMessage(
                  'Page order saved. Other pages and collection credits are unchanged.',
                );
                try {
                  await refresh(signal);
                } catch (failure) {
                  if (
                    failure instanceof AdminRequestError &&
                    [401, 403].includes(failure.status)
                  )
                    throw failure;
                  action.setError(
                    'Order saved, but the catalog could not be refreshed. Reload the page before continuing.',
                  );
                }
              },
              async (signal) => {
                const next = await refresh(signal);
                accept(next.pages.find((page) => page.id === pageId));
              },
            );
          }}
        >
          Save order
        </button>
        <button
          className="site-button"
          disabled={action.busy || !dirty}
          onClick={() => accept(latest)}
        >
          Discard order changes
        </button>
      </div>
    </section>
  );
}

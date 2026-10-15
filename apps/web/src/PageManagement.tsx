/** Manage shared collection-log pages using the current catalog and staff session. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import type { AdminCatalog, AdminClient, CreatePage } from './admin-model.ts';
import { categories, type Category } from './model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { useAdminDraft } from './admin-route-data.ts';
export function PageManagement({
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
  const [category, setCategory] = useState<Category>('bosses');
  const [name, setName] = useState(''),
    [search, setSearch] = useState('');
  const [itemIds, setItemIds] = useState<number[]>([]);
  const [pending, setPending] = useState<{
    fields: CreatePage;
    key: string;
    revision: string;
  }>();
  useEffect(() => {
    if (pending) return;
    setItemIds((ids) => {
      const current = ids.filter((id) =>
        catalog.items.some((item) => item.id === id),
      );
      return current.length === ids.length ? ids : current;
    });
  }, [catalog.items, pending]);
  const action = useAdminAction(onAccessLost),
    locked = action.busy || Boolean(pending);
  useAdminDraft(!!(name || itemIds.length || pending), action.busy);
  const pages = catalog.pages.filter((page) => page.category === category);
  const choices = catalog.items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase().trim()),
  );
  const create = () => {
    void action.execute(
      async (signal) => {
        if (
          !pending &&
          pages.some(
            (page) => page.name.toLowerCase() === name.trim().toLowerCase(),
          )
        )
          throw new Error(
            'A page with this name already exists in this category.',
          );
        const request = pending ?? {
          fields: { name: name.trim(), category, itemIds: [...itemIds] },
          key: crypto.randomUUID(),
          revision: catalog.revision,
        };
        setPending(request);
        let page;
        try {
          page = await client.createPage(
            request.fields,
            request.key,
            request.revision,
            session.csrfToken,
            signal,
          );
        } catch (failure) {
          if (
            failure instanceof AdminRequestError &&
            [400, 409, 422].includes(failure.status)
          )
            setPending(undefined);
          throw failure;
        }
        if (signal.aborted) return;
        await refresh(signal);
        if (signal.aborted) return;
        setPending(undefined);
        setName('');
        setItemIds([]);
        setSearch('');
        action.setMessage(
          `${page.name} created. The page is available in both world modes.`,
        );
      },
      async (signal) => {
        await refresh(signal);
      },
    );
  };
  const move = (index: number, offset: number) => {
    if (locked || index + offset < 0 || index + offset >= pages.length) return;
    const ids = pages.map((page) => page.id),
      moved = ids.splice(index, 1)[0]!;
    ids.splice(index + offset, 0, moved);
    void action.execute(
      async (signal) => {
        await client.reorderPages(
          category,
          ids,
          catalog.revision,
          session.csrfToken,
          signal,
        );
        if (signal.aborted) return;
        await refresh(signal);
        if (!signal.aborted) action.setMessage('Page order saved.');
      },
      async (signal) => {
        await refresh(signal);
      },
    );
  };
  return (
    <section
      className="admin-panel page-management"
      aria-labelledby="page-management-title"
    >
      <h2 id="page-management-title">Page management</h2>
      <label>
        Page category
        <select
          value={category}
          disabled={locked}
          onChange={(event) => {
            setCategory(event.target.value as Category);
            action.setMessage(undefined);
          }}
        >
          {categories.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="new-page-form"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <h3>Add page</h3>
        <label>
          Page name
          <input
            required
            maxLength={200}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="page-item-picker catalog-picker">
          <legend>Existing items (optional)</legend>
          <input
            type="search"
            aria-label="Search items for new page"
            placeholder="Search"
            value={search}
            disabled={locked}
            onChange={(event) => setSearch(event.target.value)}
          />
          <p className="admin-note">
            {itemIds.length} items selected. An empty page can receive new items
            from Add item.
          </p>
          <div className="page-item-choices catalog-choice-list">
            {choices.slice(0, 100).map((item) => (
              <label className="admin-checkbox" key={item.id}>
                <input
                  type="checkbox"
                  checked={itemIds.includes(item.id)}
                  disabled={locked}
                  aria-label={`Include ${item.name} on new page`}
                  onChange={(event) =>
                    setItemIds((ids) =>
                      event.target.checked
                        ? [...ids, item.id]
                        : ids.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.name}
              </label>
            ))}
            {!choices.length && <p>No matching items.</p>}
          </div>
          {choices.length > 100 && (
            <p className="admin-note">
              Showing the first 100 matches. Search to find more items.
            </p>
          )}
        </fieldset>
        <button
          className="site-button"
          disabled={action.busy || (!pending && !name.trim())}
        >
          {pending ? 'Retry page creation' : 'Create page'}
        </button>
        {pending && !action.busy && (
          <button
            type="button"
            className="site-button"
            onClick={() => {
              setPending(undefined);
              action.setError(undefined);
            }}
          >
            Discard page request
          </button>
        )}
      </form>
      <h3>
        Pages in {categories.find((entry) => entry.id === category)!.name}
      </h3>
      <ol
        className="page-order-list managed-pages"
        aria-label="Collection-log pages"
      >
        {pages.map((page, index) => (
          <li key={page.id}>
            <div className="order-item-name">
              <strong>{page.name}</strong>
              <span>{page.itemIds.length} items</span>
            </div>
            <span className="order-position">{index + 1}</span>
            <div className="order-move-buttons">
              <button
                type="button"
                className="site-button"
                disabled={locked || index === 0}
                aria-label={`Move page ${page.name} up`}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="site-button"
                disabled={locked || index === pages.length - 1}
                aria-label={`Move page ${page.name} down`}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="site-button"
                disabled={locked}
                aria-label={`Delete page ${page.name}`}
                onClick={() => {
                  if (
                    locked ||
                    !window.confirm(
                      `Are you sure you want to delete ${page.name} from both collection logs? Items on other pages will remain. Items with no remaining page will be removed from the catalog, while submission and review history is preserved.`,
                    )
                  )
                    return;
                  void action.execute(
                    async (signal) => {
                      const result = await client.removePage(
                        page.id,
                        catalog.revision,
                        page.version,
                        session.csrfToken,
                        signal,
                      );
                      if (signal.aborted) return;
                      await refresh(signal);
                      if (!signal.aborted)
                        action.setMessage(
                          `${page.name} deleted. ${result.retiredItemIds.length} items removed from their last page.`,
                        );
                    },
                    async (signal) => {
                      await refresh(signal);
                    },
                  );
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ol>
      {!pages.length && (
        <p className="admin-empty">No pages in this category.</p>
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
    </section>
  );
}

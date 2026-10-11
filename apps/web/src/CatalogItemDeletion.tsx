import { useEffect, useState } from 'react';
import type { AdminClient, AdminCatalog, AdminItem } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
export function CatalogItemDeletion({
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
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState<AdminItem>();
  const action = useAdminAction(onAccessLost);
  const item = catalog.items.find((row) => String(row.id) === selected);
  useEffect(() => {
    setConfirming(undefined);
  }, [catalog.revision]);
  return (
    <section className="admin-panel">
      <h2>Delete catalog item</h2>
      <p>
        Remove an item from every active collection-log page and submission
        selector. Existing submissions, approvals and audit history remain
        available to staff.
      </p>
      <label>
        Find item to delete
        <input
          value={query}
          disabled={action.busy}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected('');
            setConfirming(undefined);
          }}
        />
      </label>
      <label>
        Item to delete
        <select
          value={selected}
          disabled={action.busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setConfirming(undefined);
          }}
        >
          <option value="">Select an item</option>
          {catalog.items
            .filter(
              (row) =>
                row.name.toLowerCase().includes(query.trim().toLowerCase()) ||
                String(row.id) === query.trim(),
            )
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · Item #{row.id}
              </option>
            ))}
        </select>
      </label>
      <button
        className="site-button"
        disabled={action.busy || !item}
        onClick={() => setConfirming(item)}
      >
        Delete selected item
      </button>
      {confirming && (
        <div
          className="admin-delete-confirm"
          role="group"
          aria-label="Confirm item deletion"
        >
          <p>
            Delete {confirming.name} (Item #{confirming.id}) from the catalog?
          </p>
          <button
            className="site-button"
            disabled={action.busy}
            onClick={() => {
              void action.execute(
                async (signal) => {
                  await client.deleteItem(
                    confirming.id,
                    catalog.revision,
                    session.csrfToken,
                    signal,
                  );
                  await refresh(signal);
                  if (!signal.aborted) {
                    setSelected('');
                    setConfirming(undefined);
                    action.setMessage(
                      `${confirming.name} deleted from the active catalog.`,
                    );
                  }
                },
                async (signal) => {
                  await refresh(signal);
                },
              );
            }}
          >
            Confirm delete item
          </button>
          <button
            className="site-button"
            disabled={action.busy}
            onClick={() => setConfirming(undefined)}
          >
            Cancel
          </button>
        </div>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </section>
  );
}

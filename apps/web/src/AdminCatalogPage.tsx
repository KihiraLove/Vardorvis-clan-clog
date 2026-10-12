/** Coordinate one catalog snapshot shared by item creation and per-page order editing. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import type { AdminCatalog, AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { ItemCreator } from './ItemCreator.tsx';
import { PageOrderEditor } from './PageOrderEditor.tsx';
import { PageManagement } from './PageManagement.tsx';

export function AdminCatalogPage({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [catalog, setCatalog] = useState<AdminCatalog>(),
    [readError, setReadError] = useState<string>();
  const [loading, setLoading] = useState(true),
    [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setReadError(undefined);
    void client
      .catalog(controller.signal)
      .then((next) => {
        if (active) setCatalog(next);
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
            'Catalog could not be loaded. The last successful snapshot is preserved.',
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
  }, [client, onAccessLost, refreshKey]);
  const refresh = async (signal: AbortSignal) => {
    const next = await client.catalog(signal);
    if (!signal.aborted) {
      setCatalog(next);
      setReadError(undefined);
    }
    return next;
  };
  return (
    <>
      {loading && <p role="status">Loading catalog…</p>}
      {readError && (
        <section role="alert" className="admin-panel admin-error">
          <p>{readError}</p>
          <button
            className="site-button"
            onClick={() => setRefreshKey((n) => n + 1)}
          >
            Retry catalog
          </button>
        </section>
      )}
      {catalog && (
        <div className="catalog-editor-layout">
          <ItemCreator
            client={client}
            catalog={catalog}
            session={session}
            onAccessLost={onAccessLost}
            refresh={refresh}
          />
          <PageOrderEditor
            client={client}
            catalog={catalog}
            session={session}
            onAccessLost={onAccessLost}
            refresh={refresh}
          />
          <PageManagement
            client={client}
            catalog={catalog}
            session={session}
            onAccessLost={onAccessLost}
            refresh={refresh}
          />
        </div>
      )}
    </>
  );
}

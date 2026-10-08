/** Resolve the admin session before mounting private queue/catalog views; share navigation. */
import { useCallback, useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { AdminSettings } from './AdminSettings.tsx';
import { AdminQueue } from './AdminQueue.tsx';
import { AdminCatalogPage } from './AdminCatalogPage.tsx';

export interface AdminRouteProps {
  preview: boolean;
  path: string;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}
export function AdminNavigation({
  preview,
  path,
  onNavigate,
}: AdminRouteProps) {
  return (
    <nav className="admin-navigation" aria-label="Admin navigation">
      {[
        ['/admin', 'Submissions'],
        ['/admin/catalog', 'Catalog items'],
        ['/admin/xp', 'XP imports'],
      ].map(([url, label]) => (
        <a
          key={url}
          href={url + (preview ? '?preview=1' : '')}
          onClick={onNavigate}
          aria-current={path === url ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
export function AdminPage({
  client,
  preview,
  path,
  onMode,
  onNavigate,
}: AdminRouteProps & {
  client: AdminClient;
  onMode: (next: boolean) => void;
}) {
  const [session, setSession] = useState<AdminSession | null>(),
    [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const accessLost = useCallback(() => setSession(null), []);
  const action = useAdminAction(accessLost);
  useEffect(() => {
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setSession(undefined);
    setError(undefined);
    void client
      .session(controller.signal)
      .then((next) => {
        if (active) setSession(next);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof AdminRequestError
              ? failure.message
              : 'Could not check admin access. Reload to try again.',
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh]);
  return (
    <div className="admin-page">
      {preview && (
        <div className="preview-banner">
          <div>
            <strong>Frontend preview</strong>
            <p>
              Sample submissions and catalog edits stay in this browser session.
              No clan data is changed.
            </p>
          </div>
          <button
            type="button"
            className="site-button"
            onClick={() => onMode(false)}
          >
            View live admin
          </button>
        </div>
      )}
      {session?.development && (
        <div className="preview-banner" role="status">
          Local test admin — no Discord login required. Changes are saved to a
          separate test database, not clan production.
        </div>
      )}
      <div className="admin-heading">
        <div>
          <p className="xp-eyebrow">Vardorvis clan</p>
          <h1>Clan administration</h1>
        </div>
        {session && (
          <div className="admin-account">
            <span>{session.displayName}</span>
            {!session.development && (
              <button
                className="site-button"
                disabled={action.busy}
                onClick={() => {
                  void action.execute(async (signal) => {
                    await client.logout(session.csrfToken, signal);
                    if (!signal.aborted) accessLost();
                  });
                }}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
      <AdminNavigation preview={preview} path={path} onNavigate={onNavigate} />
      {session && (
        <AdminSettings
          client={client}
          session={session}
          onAccessLost={accessLost}
        />
      )}
      {action.error && (
        <p role="alert" className="admin-error">
          {action.error}
        </p>
      )}
      {error ? (
        <section className="admin-panel">
          <h2>Admin access unavailable</h2>
          <p role="alert">{error}</p>
          <div className="admin-actions">
            <button
              className="site-button"
              onClick={() => setRefresh((v) => v + 1)}
            >
              Retry admin access
            </button>
            {!preview && (
              <button className="site-button" onClick={() => onMode(true)}>
                View admin preview
              </button>
            )}
          </div>
        </section>
      ) : session === undefined ? (
        <p role="status">Checking admin access…</p>
      ) : session === null ? (
        <section className="admin-panel">
          <h2>Admin sign-in required</h2>
          <p>
            Only allowlisted clan admins can review submissions or maintain the
            catalog.
          </p>
          <a className="site-button" href="/api/v1/auth/discord">
            Sign in with Discord
          </a>
          {preview && (
            <p className="admin-note">
              Reload to start a new signed-in preview session.
            </p>
          )}
        </section>
      ) : path === '/admin/catalog' ? (
        <AdminCatalogPage
          client={client}
          session={session}
          onAccessLost={accessLost}
        />
      ) : (
        <AdminQueue
          client={client}
          session={session}
          onAccessLost={accessLost}
        />
      )}
    </div>
  );
}

/** Public entry keeps staff screens behind explicit route preparation. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SiteApp } from './SiteApp.tsx';
import { useRouteNavigation } from './use-route-navigation.ts';
import { LiveAdminClient } from './admin-api.ts';
import { LiveXpClient } from './xp-api.ts';
import { LiveCompetitionClient } from './competition-api.ts';
import { prepareAppRoute } from './prepare-app-route.ts';
import { isAdminPath } from './admin-route-data.ts';
import type { AppRuntime } from './app-runtime.ts';

export function App() {
  const [live] = useState<AppRuntime>(() => ({
    admin: new LiveAdminClient(),
    xp: new LiveXpClient(),
    competition: new LiveCompetitionClient(),
  }));
  const visible = useRef({ runtime: live, admin: false });
  const prepare = useCallback(
    (route: { path: string }, signal: AbortSignal) =>
      prepareAppRoute(route, visible.current, live, signal),
    [live],
  );
  const navigation = useRouteNavigation(prepare);
  const resources = navigation.route.resources;
  useEffect(() => {
    if (!resources) return;
    visible.current = {
      runtime: resources.runtime,
      admin: isAdminPath(navigation.route.path),
    };
  }, [resources, navigation.route.path, live]);
  const pending = navigation.pending;
  return (
    <>
      {pending && (
        <aside className="admin-route-status" aria-label="Page navigation">
          <p role={pending.error ? 'alert' : 'status'}>
            {pending.error ?? 'Loading page…'}
          </p>
          {pending.codeFailure ? (
            <button
              className="site-button"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          ) : (
            pending.error && (
              <button className="site-button" onClick={pending.retry}>
                Retry navigation
              </button>
            )
          )}
          {resources && (
            <button className="site-button" onClick={pending.cancel}>
              Cancel navigation
            </button>
          )}
        </aside>
      )}
      {resources ? (
        <SiteApp navigation={navigation} resources={resources} />
      ) : (
        <main className="site-shell">
          <h1>Clan Collection Log</h1>
          <p>
            {isAdminPath(navigation.route.path)
              ? 'Checking admin access…'
              : 'Preparing this page before showing its forms.'}
          </p>
        </main>
      )}
    </>
  );
}

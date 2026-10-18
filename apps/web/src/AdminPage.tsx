/** Resolve the admin session before mounting private queue/catalog views; share navigation. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreparedAdminEntry } from './app-runtime.ts';
import { AdminRequestError } from './admin-api.ts';
import {
  classifyAccessFailure,
  visibleAdminSession,
  type AdminAccess,
} from './admin-session.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { AdminRouteContext, adminRouteLabels } from './admin-route-data.ts';
import { useAdminRoutes, type AdminNavigator } from './use-admin-routes.ts';
import { withAbort } from './with-abort.ts';
import { useAdminAction } from './use-admin-action.ts';
import type { SiteSettings } from './site-settings.ts';
import type { Branding } from './branding.ts';
import { AdminSettings } from './AdminSettings.tsx';
import { AdminQueue } from './AdminQueue.tsx';
import { AdminCatalogPage } from './AdminCatalogPage.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { AdminAccounts } from './AdminAccounts.tsx';
import { RuneLiteReviewSettings } from './RuneLiteReviewSettings.tsx';
import { AdminScheduling } from './AdminScheduling.tsx';
import { DiscordBotSettings } from './DiscordBotSettings.tsx';
import type { CompetitionClient } from './competition-api.ts';

export interface AdminRouteProps {
  path: string;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}
export function AdminNavigation({
  path,
  onNavigate,
  session,
}: AdminRouteProps & { session?: AdminSession | null | undefined }) {
  if (!session || session.mustChangePassword) return null;
  return (
    <nav className="admin-navigation" aria-label="Admin navigation">
      {[
        ['/admin', 'Submissions'],
        ['/admin/catalog', 'Items catalog'],
        ['/admin/schedules', 'Scheduling and Competitions'],
        ['/admin/runelite', 'RuneLite submissions'],
        ...(session?.role === 'admin'
          ? [
              ['/admin/settings', 'Site settings'],
              ['/admin/settings/hardcore', 'Hardcore worlds'],
              ['/admin/discord', 'Discord bot'],
              ['/admin/accounts', 'Moderator accounts'],
            ]
          : []),
        ['/admin/account', 'Your account'],
      ].map(([url, label]) => (
        <a
          key={url}
          href={url}
          onClick={onNavigate}
          aria-current={
            path === url || (path === '/admin/xp' && url === '/admin/schedules')
              ? 'page'
              : undefined
          }
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
export function AdminPage({
  client,
  path,
  onNavigate,
  clanName,
  hardcoreEnabled,
  onSettingsSaved,
  onBrandingSaved,
  competitionClient,
  registerNavigation,
  initial,
}: AdminRouteProps & {
  client: AdminClient;
  competitionClient: CompetitionClient;
  registerNavigation: (navigator: AdminNavigator | null) => void;
  clanName: string;
  hardcoreEnabled: boolean;
  onSettingsSaved: (settings: SiteSettings) => void;
  onBrandingSaved: (branding: Branding, hardcore?: boolean) => void;
  initial?: PreparedAdminEntry | undefined;
}) {
  const [access, setAccess] = useState<AdminAccess>(
      () => initial?.access ?? { phase: 'checking' },
    ),
    [error, setError] = useState<string | undefined>(initial?.error);
  const session = access.phase === 'authenticated' ? access.session : null;
  const [refresh, setRefresh] = useState(0);
  const preparedAccess = useRef(Boolean(initial));
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const accessLost = useCallback(() => {
    setAccess({ phase: 'expired' });
    setError(undefined);
  }, []);
  const signedOut = useCallback(() => {
    setAccess({ phase: 'signed-out' });
    setError(undefined);
  }, []);
  const routes = useAdminRoutes({
    path,
    session,
    client,
    onAccessLost: accessLost,
    register: registerNavigation,
    initial,
  });
  const action = useAdminAction(accessLost);
  const loginAction = useAdminAction(accessLost);
  const loggingIn = loginAction.busy,
    loginError = loginAction.error;
  const logIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await loginAction.execute(async (signal) => {
      try {
        await client.login(username, password, signal);
        if (signal.aborted) return;
        const next = await client.session(signal);
        if (signal.aborted) return;
        if (!next) throw new Error('Session not established.');
        setAccess({ phase: 'authenticated', session: next });
        setError(undefined);
        setPassword('');
      } catch (failure) {
        if (signal.aborted) throw failure;
        throw new Error(
          failure instanceof AdminRequestError && failure.status === 401
            ? 'Incorrect username or password.'
            : failure instanceof AdminRequestError && failure.status === 429
              ? 'Too many attempts. Try again later.'
              : 'Could not sign in. Check your credentials and try again.',
          { cause: failure },
        );
      }
    });
  };
  useEffect(() => {
    if (preparedAccess.current) {
      preparedAccess.current = false;
      return;
    }
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setAccess({ phase: 'checking' });
    setError(undefined);
    void withAbort(client.session(controller.signal), controller.signal)
      .then((next) => {
        if (active && !controller.signal.aborted)
          setAccess(
            next
              ? { phase: 'authenticated', session: next }
              : { phase: 'signed-out' },
          );
      })
      .catch((failure: unknown) => {
        if (!active) return;
        const accessFailure = classifyAccessFailure(failure);
        if (accessFailure !== 'other') {
          setAccess({ phase: 'expired' });
          setError(undefined);
        } else {
          setAccess({ phase: 'checking' });
          setError('Could not check admin access. Reload to try again.');
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh]);
  return (
    <AdminRouteContext.Provider
      value={
        routes.ready ? { data: routes.ready.data, drafts: routes.drafts } : null
      }
    >
      <div className="admin-page">
        <div className="admin-heading">
          <div>
            <p className="xp-eyebrow">{clanName} clan</p>
            <h1>Clan administration</h1>
          </div>
          {session && (
            <div className="admin-account">
              <span>{session.displayName}</span>
              <button
                className="site-button"
                disabled={action.busy}
                onClick={() => {
                  void action.execute(async (signal) => {
                    await client.logout(session.csrfToken, signal);
                    if (!signal.aborted) signedOut();
                  });
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        {visibleAdminSession(access) && (
          <AdminNavigation
            path={path}
            onNavigate={onNavigate}
            session={session}
          />
        )}
        {routes.pending && session && (
          <aside className="admin-route-status" aria-label="Page navigation">
            <p role={routes.pending.error ? 'alert' : 'status'}>
              {routes.pending.error ??
                `Loading ${adminRouteLabels[routes.pending.label] ?? routes.pending.label}…`}
            </p>
            <div className="admin-actions">
              {routes.pending.codeFailure ? (
                <button
                  className="site-button"
                  onClick={() => window.location.reload()}
                >
                  Reload page
                </button>
              ) : (
                routes.pending.error && (
                  <button className="site-button" onClick={routes.retry}>
                    Retry navigation
                  </button>
                )
              )}
              <button className="site-button" onClick={routes.cancel}>
                Cancel navigation
              </button>
            </div>
          </aside>
        )}
        {session?.role === 'admin' &&
          !session.mustChangePassword &&
          routes.ready?.path === path &&
          routes.ready.data.kind === 'settings' &&
          (path === '/admin/settings' ||
            path === '/admin/settings/hardcore') && (
            <AdminSettings
              key={path}
              hardcore={path === '/admin/settings/hardcore'}
              client={client}
              session={session}
              onAccessLost={accessLost}
              onSaved={onSettingsSaved}
              onBrandingSaved={(value) =>
                onBrandingSaved(value, path === '/admin/settings/hardcore')
              }
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
            </div>
          </section>
        ) : access.phase === 'checking' ? (
          <p role="status">Checking admin access…</p>
        ) : access.phase === 'signed-out' || access.phase === 'expired' ? (
          <section className="admin-panel">
            <h2>
              {access.phase === 'expired'
                ? 'Admin session expired'
                : 'Admin sign-in required'}
            </h2>
            <p>Sign in with your administrator or moderator account.</p>
            <form
              className="admin-credential-form"
              onSubmit={(event) => void logIn(event)}
            >
              <label htmlFor="admin-username">Username</label>
              <input
                id="admin-username"
                autoComplete="username"
                required
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <label htmlFor="admin-password">Password</label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                className="site-button"
                type="submit"
                disabled={loggingIn}
              >
                {loggingIn ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            {loginError && (
              <p role="alert" className="admin-error">
                {loginError}
              </p>
            )}
          </section>
        ) : !session ? null : routes.ready?.path !== path ? (
          <section
            className="admin-panel admin-route-shell"
            aria-busy={!routes.pending?.error}
          >
            <h2>Loading {adminRouteLabels[path] ?? 'Submissions'}…</h2>
            <p role="status">Preparing this page before showing its forms.</p>
          </section>
        ) : routes.ready.data.kind === 'denied' ? (
          <p role="alert">{routes.ready.data.denial}</p>
        ) : session.mustChangePassword || path === '/admin/account' ? (
          <AccountSettings
            client={client}
            session={session}
            onSaved={(next) => {
              setAccess({ phase: 'authenticated', session: next });
              setError(undefined);
            }}
            onAccessLost={accessLost}
          />
        ) : path === '/admin/schedules' || path === '/admin/xp' ? (
          <AdminScheduling
            client={client}
            session={session}
            onAccessLost={accessLost}
            competitionClient={competitionClient}
          />
        ) : path === '/admin/runelite' ? (
          <section className="admin-panel">
            <h2>RuneLite submissions</h2>
            <RuneLiteReviewSettings
              client={client}
              session={session}
              onAccessLost={accessLost}
            />
          </section>
        ) : path === '/admin/discord' && session.role === 'admin' ? (
          <DiscordBotSettings
            client={client}
            session={session}
            onAccessLost={accessLost}
          />
        ) : path === '/admin/accounts' ? (
          session.role === 'admin' ? (
            <AdminAccounts
              client={client}
              session={session}
              onAccessLost={accessLost}
            />
          ) : (
            <p role="alert">
              Only the administrator can create moderator accounts.
            </p>
          )
        ) : path === '/admin/settings' ||
          path === '/admin/settings/hardcore' ? (
          session.role === 'admin' ? null : (
            <p role="alert">Only the administrator can change site settings.</p>
          )
        ) : path === '/admin/catalog' ? (
          <AdminCatalogPage
            client={client}
            session={session}
            onAccessLost={accessLost}
          />
        ) : (
          <AdminQueue
            hardcoreEnabled={hardcoreEnabled}
            client={client}
            session={session}
            onAccessLost={accessLost}
          />
        )}
      </div>
    </AdminRouteContext.Provider>
  );
}

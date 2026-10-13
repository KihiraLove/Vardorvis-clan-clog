/** Resolve the admin session before mounting private queue/catalog views; share navigation. */
import { useCallback, useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  classifyAccessFailure,
  visibleAdminSession,
  type AdminAccess,
} from './admin-session.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import type { SiteSettings } from './site-settings.ts';
import type { Branding } from './branding.ts';
import { AdminSettings } from './AdminSettings.tsx';
import { AdminQueue } from './AdminQueue.tsx';
import { AdminCatalogPage } from './AdminCatalogPage.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { AdminAccounts } from './AdminAccounts.tsx';
import { ClanApiKeySettings } from './ClanApiKeySettings.tsx';
import { RuneLiteReviewSettings } from './RuneLiteReviewSettings.tsx';
import { AdminScheduling } from './AdminScheduling.tsx';
import type { CompetitionClient } from './competition-api.ts';

export interface AdminRouteProps {
  preview: boolean;
  path: string;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}
export function AdminNavigation({
  preview,
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
        ['/admin/xp', 'XP imports'],
        ['/admin/schedules', 'Scheduling'],
        ...(session?.role === 'admin'
          ? [
              ['/admin/runelite', 'RuneLite submissions'],
              ['/admin/settings', 'Site settings'],
              ['/admin/settings/hardcore', 'Hardcore worlds'],
              ['/admin/accounts', 'Moderator accounts'],
            ]
          : []),
        ['/admin/account', 'Your account'],
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
  children,
  clanName,
  onSettingsSaved,
  onBrandingSaved,
  competitionClient,
}: AdminRouteProps & {
  client: AdminClient;
  competitionClient: CompetitionClient;
  clanName: string;
  onSettingsSaved: (settings: SiteSettings) => void;
  onBrandingSaved: (branding: Branding, hardcore?: boolean) => void;
  onMode: (next: boolean) => void;
  children?: (session: AdminSession, onAccessLost: () => void) => React.ReactNode;
}) {
  const [access, setAccess] = useState<AdminAccess>({ phase: 'checking' }),
    [error, setError] = useState<string>();
  const session = access.phase === 'authenticated' ? access.session : null;
  const [refresh, setRefresh] = useState(0);
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
    let active = true;
    const controller = new AbortController(),
      timer = window.setTimeout(() => controller.abort(), 10000);
    setAccess({ phase: 'checking' });
    setError(undefined);
    void client
      .session(controller.signal)
      .then((next) => {
        if (active)
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
          preview={preview}
          path={path}
          onNavigate={onNavigate}
          session={session}
        />
      )}
      {session?.role === 'admin' &&
        !session.mustChangePassword &&
        (path === '/admin/settings' || path === '/admin/settings/hardcore') && (
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
            {!preview && (
              <button className="site-button" onClick={() => onMode(true)}>
                View admin preview
              </button>
            )}
          </div>
        </section>
      ) : access.phase === 'checking' ? (
        <p role="status">Checking admin access…</p>
      ) : access.phase === 'signed-out' || access.phase === 'expired' ? (
        <section className="admin-panel">
          <h2>{access.phase === 'expired' ? 'Admin session expired' : 'Admin sign-in required'}</h2>
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
            <button className="site-button" type="submit" disabled={loggingIn}>
              {loggingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          {loginError && (
            <p role="alert" className="admin-error">
              {loginError}
            </p>
          )}
          {preview && (
            <p className="admin-note">
              Reload to start a new signed-in preview session.
            </p>
          )}
        </section>
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
      ) : path === '/admin/schedules' ? (
        <AdminScheduling
          client={client}
          session={session}
          onAccessLost={accessLost}
          competitionClient={competitionClient}
        />
      ) : path === '/admin/runelite' ? (
        session.role === 'admin' ? (
          <section className="admin-panel">
            <h2>RuneLite submissions</h2>
            <ClanApiKeySettings
              client={client}
              session={session}
              onAccessLost={accessLost}
            />
            <RuneLiteReviewSettings
              client={client}
              session={session}
              onAccessLost={accessLost}
            />
          </section>
        ) : (
          <p role="alert">
            Only the administrator can change RuneLite settings.
          </p>
        )
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
      ) : path === '/admin/settings' || path === '/admin/settings/hardcore' ? (
        session.role === 'admin' ? null : (
          <p role="alert">Only the administrator can change site settings.</p>
        )
      ) : children ? (
        children(session, accessLost)
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

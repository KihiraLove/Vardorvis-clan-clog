/** Administrator-only moderator creation; temporary passwords are never redisplayed. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import type { AdminClient, StaffAccount } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';

export function AdminAccounts({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [accounts, setAccounts] = useState<StaffAccount[]>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const action = useAdminAction(onAccessLost);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    setError(undefined);
    void client
      .accounts(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setAccounts(rows);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          onAccessLost();
        else
          setError('Accounts could not be loaded. Retry to refresh the list.');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh, onAccessLost]);
  return (
    <section className="admin-panel">
      <h2>Moderator accounts</h2>
      <p>
        Moderators can review submissions and use the submission, catalog and XP
        tools. Each moderator must change their temporary password on first
        login.
      </p>
      <form
        className="admin-credential-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async (signal) => {
            const account = await client.createModerator(
              username,
              password,
              session.csrfToken,
              signal,
            );
            if (signal.aborted) return;
            setAccounts((rows) => [...(rows ?? []), account]);
            setUsername('');
            setPassword('');
            action.setMessage(`Moderator ${account.username} created.`);
          });
        }}
      >
        <label htmlFor="moderator-username">Moderator username</label>
        <input
          id="moderator-username"
          autoComplete="off"
          required
          minLength={3}
          maxLength={32}
          pattern="[A-Za-z0-9_.\-]{3,32}"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label htmlFor="moderator-password">Temporary password</label>
        <input
          id="moderator-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={256}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="admin-note">
          Use at least 12 characters and share these credentials with the
          moderator.
        </p>
        <button className="site-button" disabled={action.busy}>
          {action.busy ? 'Creating…' : 'Create moderator'}
        </button>
      </form>
      {action.error && (
        <p role="alert" className="admin-error">
          {action.error}
        </p>
      )}
      {action.message && <p role="status">{action.message}</p>}
      {error ? (
        <p role="alert">
          {error}{' '}
          <button
            className="site-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry accounts
          </button>
        </p>
      ) : !accounts ? (
        <p role="status">Loading accounts…</p>
      ) : (
        <div className="admin-account-list">
          <h3>Existing accounts</h3>
          <ul>
            {accounts.map((account) => (
              <li key={account.id}>
                <strong>{account.username}</strong> · {account.role} ·{' '}
                {account.mustChangePassword
                  ? 'Password change required'
                  : 'Active'}
              </li>
            ))}
          </ul>
          {accounts.every((account) => account.role !== 'moderator') && (
            <p>No moderator accounts have been created.</p>
          )}
        </div>
      )}
    </section>
  );
}

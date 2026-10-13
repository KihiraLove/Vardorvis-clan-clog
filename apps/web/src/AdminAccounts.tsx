/** Administrator-only moderator management; temporary passwords are never redisplayed. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import { classifyAccessFailure } from './admin-session.ts';
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
  const [deleting, setDeleting] = useState<StaffAccount>();
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
          classifyAccessFailure(failure) === 'expired'
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
  const manage = (
    account: StaffAccount,
    change: 'disable' | 'enable' | 'delete',
  ) => {
    void action.execute(
      async (signal) => {
        const value = await client.manageModerator(
          account.id,
          account.version ?? 1,
          change,
          session.csrfToken,
          signal,
        );
        if (!signal.aborted) {
          setAccounts((rows) =>
            change === 'delete'
              ? rows?.filter((row) => row.id !== account.id)
              : rows?.map((row) => (row.id === account.id ? value : row)),
          );
          setDeleting(undefined);
          action.setMessage(
            `Moderator ${account.username} ${change === 'enable' ? 'enabled' : change === 'disable' ? 'disabled' : 'deleted'}.`,
          );
        }
      },
      async (signal) => {
        const rows = await client.accounts(signal);
        if (!signal.aborted) {
          setAccounts(rows);
          setDeleting(undefined);
        }
      },
    );
  };
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
                {account.disabled
                  ? 'Disabled'
                  : account.mustChangePassword
                    ? 'Password change required'
                    : 'Active'}
                {account.role === 'moderator' && (
                  <div className="admin-actions">
                    <button
                      className="site-button"
                      aria-label={`${account.disabled ? 'Enable' : 'Disable'} ${account.username}`}
                      disabled={action.busy}
                      onClick={() =>
                        manage(account, account.disabled ? 'enable' : 'disable')
                      }
                    >
                      {account.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      className="site-button"
                      aria-label={`Delete ${account.username}`}
                      disabled={action.busy}
                      onClick={() => setDeleting(account)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {deleting && (
            <div
              className="admin-delete-confirm"
              role="group"
              aria-label="Confirm moderator deletion"
            >
              <p>
                Delete {deleting.username}? Their access ends immediately. Past
                submissions and review history are preserved.
              </p>
              <button
                className="site-button"
                disabled={action.busy}
                onClick={() => manage(deleting, 'delete')}
              >
                Confirm delete moderator
              </button>
              <button
                className="site-button"
                disabled={action.busy}
                onClick={() => setDeleting(undefined)}
              >
                Cancel
              </button>
            </div>
          )}
          {accounts.every((account) => account.role !== 'moderator') && (
            <p>No moderator accounts have been created.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Self-service credentials and mandatory first-login setup. */
import { useState } from 'react';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';

export function AccountSettings({
  client,
  session,
  onSaved,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onSaved: (session: AdminSession) => void;
  onAccessLost: () => void;
}) {
  const [username, setUsername] = useState(session.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const action = useAdminAction(onAccessLost);
  return (
    <section className="admin-panel">
      <h2>
        {session.mustChangePassword
          ? 'Change your password to continue'
          : 'Your account'}
      </h2>
      <p>
        {session.mustChangePassword
          ? 'Choose a new password before using the staff tools. You can also change your username here.'
          : 'Update your username or password. Enter your current password to save changes.'}
      </p>
      <form
        className="admin-credential-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (newPassword !== confirmation) {
            action.setError('The new passwords do not match.');
            return;
          }
          void action.execute(async (signal) => {
            const next = await client.updateAccount(
              {
                username,
                currentPassword,
                ...(newPassword ? { newPassword } : {}),
              },
              session.csrfToken,
              signal,
            );
            if (signal.aborted) return;
            setCurrentPassword('');
            setNewPassword('');
            setConfirmation('');
            onSaved(next);
            action.setMessage(
              'Account updated. Other sessions have been signed out.',
            );
          });
        }}
      >
        <label htmlFor="account-username">Username</label>
        <input
          id="account-username"
          autoComplete="username"
          required
          minLength={3}
          maxLength={32}
          pattern="[A-Za-z0-9_.\-]{3,32}"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <p className="admin-note">
          3–32 letters, numbers, dots, underscores or hyphens.
        </p>
        <label htmlFor="account-current-password">Current password</label>
        <input
          id="account-current-password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={256}
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="account-new-password">New password</label>
        <input
          id="account-new-password"
          type="password"
          autoComplete="new-password"
          required={session.mustChangePassword}
          minLength={12}
          maxLength={256}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <p className="admin-note">Use at least 12 characters.</p>
        <label htmlFor="account-confirm-password">Confirm new password</label>
        <input
          id="account-confirm-password"
          type="password"
          autoComplete="new-password"
          required={!!newPassword || session.mustChangePassword}
          maxLength={256}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <button className="site-button" disabled={action.busy}>
          {action.busy ? 'Saving…' : 'Save account'}
        </button>
      </form>
      {action.error && (
        <p className="admin-error" role="alert">
          {action.error}
        </p>
      )}
      {action.message && <p role="status">{action.message}</p>}
    </section>
  );
}

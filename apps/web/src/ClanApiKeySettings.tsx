/** Key management remains available while the intake requirement is disabled. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { validClanKey, type ClanKeySettings } from './clan-api-key.ts';
import { useAdminAction } from './use-admin-action.ts';
import { clanKeyBytes, clanKeyMinLength } from '@clog/domain';
import { useAdminDraft } from './admin-route-data.ts';

export function ClanApiKeySettings({
  client,
  session,
  onAccessLost,
  settings: saved,
  onSaved,
  busy = false,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  settings: ClanKeySettings | undefined;
  onSaved: (value: ClanKeySettings) => void;
  busy?: boolean;
}) {
  const [key, setKey] = useState(saved?.key ?? '');
  const action = useAdminAction(onAccessLost);
  const locked = busy || action.busy;
  const editable = session.role === 'admin';
  useAdminDraft(editable && !!saved && key !== saved.key, action.busy);
  const accept = (value: ClanKeySettings) => {
    onSaved(value);
    setKey(value.key);
  };
  useEffect(() => {
    setKey(saved?.key ?? '');
  }, [saved?.key]);
  const save = () => {
    if (!saved || !editable) return;
    void action.execute(
      async (signal) => {
        const value = await client.saveClanApiKey(
          { key, expectedRevision: saved.revision },
          session.csrfToken,
          signal,
        );
        if (!signal.aborted) {
          accept(value);
          action.setMessage('Clan API key settings saved.');
        }
      },
      async (signal) => {
        const value = await client.clanApiKey(signal);
        if (!signal.aborted) accept(value);
      },
    );
  };
  return (
    <div className="clan-api-key-settings">
      <h3>RuneLite shared API key</h3>
      <form
        aria-busy={!saved}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor="clan-api-key-value">Current shared API key</label>
        <textarea
          id="clan-api-key-value"
          className="clan-api-key-value"
          value={key}
          readOnly={!editable}
          required
          minLength={clanKeyMinLength}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          disabled={locked || !saved}
          placeholder={saved ? undefined : 'Loading API key…'}
          onChange={(event) => {
            setKey(event.target.value);
            action.setMessage(undefined);
          }}
        />
        {editable && (
          <div className="admin-actions">
            <button
              type="button"
              className="site-button"
              disabled={locked || !saved}
              onClick={() => {
                const bytes = crypto.getRandomValues(
                  new Uint8Array(clanKeyBytes),
                );
                setKey(
                  Array.from(bytes, (byte) =>
                    byte.toString(16).padStart(2, '0'),
                  ).join(''),
                );
                action.setMessage('New key generated. Save to apply it.');
              }}
            >
              Generate new key
            </button>
            <button
              className="site-button"
              disabled={
                locked || !saved || !validClanKey(key) || key === saved.key
              }
            >
              Save API key settings
            </button>
          </div>
        )}
      </form>
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </div>
  );
}

/** Key management remains available while the intake requirement is disabled. */
import { useEffect, useState } from 'react';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { AdminRequestError } from './admin-api.ts';
import { validClanKey, type ClanKeySettings } from './clan-api-key.ts';
import { useAdminAction } from './use-admin-action.ts';

export function ClanApiKeySettings({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [saved, setSaved] = useState<ClanKeySettings>();
  const [enabled, setEnabled] = useState(true);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const accept = (value: ClanKeySettings) => {
    setSaved(value);
    setEnabled(value.enabled);
    setKey(value.key);
  };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setError(undefined);
    setSaved(undefined);
    void client
      .clanApiKey(controller.signal)
      .then((value) => {
        if (active && !controller.signal.aborted) {
          setSaved(value);
          setEnabled(value.enabled);
          setKey(value.key);
        }
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        ) {
          onAccessLost();
          return;
        }
        setError('API key settings are unavailable.');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [client, onAccessLost, refresh]);
  const save = () => {
    if (!saved) return;
    void action.execute(
      async (signal) => {
        const value = await client.saveClanApiKey(
          { key: key.trim(), enabled, expectedRevision: saved.revision },
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
      <p>
        When required, RuneLite submissions must include this key and match the
        clan name. Turning it off keeps the key available and checks submissions
        by clan name.
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRefresh((n) => n + 1)}>
            Retry API key settings
          </button>
        </p>
      )}
      {saved && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={action.busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Require clan API key
          </label>
          <label>
            Current shared API key
            <input
              className="clan-api-key-value"
              type="text"
              value={key}
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              disabled={action.busy}
              onChange={(event) => {
                setKey(event.target.value);
                action.setMessage(undefined);
              }}
            />
          </label>
          <p className="admin-note">
            Generate or enter a key, then save to apply the key and requirement
            together. Send the saved value in the X-Clan-API-Key header.
          </p>
          <div className="admin-actions">
            <button
              type="button"
              className="site-button"
              disabled={action.busy}
              onClick={() => {
                const bytes = crypto.getRandomValues(new Uint8Array(32));
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
                action.busy ||
                !validClanKey(key.trim()) ||
                (enabled === saved.enabled && key.trim() === saved.key)
              }
            >
              Save API key settings
            </button>
          </div>
        </form>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </div>
  );
}

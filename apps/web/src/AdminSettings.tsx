/** Admin-only release switch. Live persistence requires the authenticated settings API. */
import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import type { SiteSettings } from './site-settings.ts';
import { useAdminAction } from './use-admin-action.ts';
export function AdminSettings({
  client,
  session,
  onAccessLost,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const [saved, setSaved] = useState<SiteSettings>();
  const [enabled, setEnabled] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  useEffect(() => {
    let active = true;
    setSaved(undefined);
    setReadError(undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    void client
      .settings(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSaved(value);
          setEnabled(value.hardcoreEnabled);
          setReadError(undefined);
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
        setReadError(
          'Settings are unavailable. Hardcore remains hidden until a saved setting can be read.',
        );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh, onAccessLost]);
  return (
    <section className="admin-panel">
      <h2>Site settings</h2>
      <p>
        Enable hardcore worlds when they are released. Disabling the switch
        hides the skull and preserves recorded hardcore collections.
      </p>
      {readError && (
        <p role="alert">
          {readError}{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>
            Retry settings
          </button>
        </p>
      )}
      {saved && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action.execute(
              async (signal) => {
                const value = await client.saveSettings(
                  enabled,
                  saved.revision,
                  session.csrfToken,
                  signal,
                );
                if (!signal.aborted) {
                  setSaved(value);
                  setEnabled(value.hardcoreEnabled);
                  action.setMessage('Hardcore visibility saved.');
                }
              },
              async (signal) => {
                const value = await client.settings(signal);
                if (!signal.aborted) {
                  setSaved(value);
                  setEnabled(value.hardcoreEnabled);
                }
              },
            );
          }}
        >
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={action.busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable hardcore worlds
          </label>
          <button
            className="site-button"
            disabled={action.busy || enabled === saved.hardcoreEnabled}
          >
            Save site settings
          </button>
        </form>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </section>
  );
}

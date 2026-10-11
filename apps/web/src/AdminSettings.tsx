/** Admin-only release switch. Live persistence requires the authenticated settings API. */
import { useEffect, useState } from 'react';
import { ClanApiKeySettings } from './ClanApiKeySettings.tsx';
import { ClanLogoSettings } from './ClanLogoSettings.tsx';
import type { Branding } from './branding.ts';
import { AdminRequestError } from './admin-api.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import type { SiteSettings } from './site-settings.ts';
import { useAdminAction } from './use-admin-action.ts';
import { defaultSiteCopy, parseSiteCopy, type SiteCopy } from '@clog/domain';
export function AdminSettings({
  client,
  session,
  onAccessLost,
  onSaved,
  onBrandingSaved,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  onSaved?: ((settings: SiteSettings) => void) | undefined;
  onBrandingSaved: (branding: Branding) => void;
}) {
  const [saved, setSaved] = useState<SiteSettings>();
  const [enabled, setEnabled] = useState(false);
  const [clanName, setClanName] = useState('');
  const [copy, setCopy] = useState<SiteCopy>({ ...defaultSiteCopy });
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
          setClanName(value.clanName);
          setCopy(value.copy ?? { ...defaultSiteCopy });
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
                  clanName.trim(),
                  parseSiteCopy(copy),
                );
                if (!signal.aborted) {
                  setSaved(value);
                  setEnabled(value.hardcoreEnabled);
                  setClanName(value.clanName);
                  setCopy(value.copy ?? { ...defaultSiteCopy });
                  onSaved?.(value);
                  action.setMessage('Site settings saved.');
                }
              },
              async (signal) => {
                const value = await client.settings(signal);
                if (!signal.aborted) {
                  setSaved(value);
                  setEnabled(value.hardcoreEnabled);
                  setClanName(value.clanName);
                  setCopy(value.copy ?? { ...defaultSiteCopy });
                  onSaved?.(value);
                }
              },
            );
          }}
        >
          <label>
            Clan name
            <input
              required
              maxLength={80}
              value={clanName}
              disabled={action.busy}
              onChange={(event) => setClanName(event.target.value)}
            />
          </label>
          <p className="admin-note">
            Shown on the website and required for RuneLite submissions.
          </p>
          <label className="admin-checkbox">
            <input
              type="checkbox"
              checked={enabled}
              disabled={action.busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enable hardcore worlds
          </label>
          <fieldset className="site-copy-fields">
            <legend>Website text</legend>
            {(
              [
                ['collectionTitle', 'Collection log title'],
                ['collectionCaption', 'Collection log caption'],
                ['xpTitle', 'XP section title'],
                ['xpTotalCaption', 'XP total caption'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required
                  maxLength={160}
                  disabled={action.busy}
                  value={copy[key]}
                  onChange={(event) =>
                    setCopy((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </fieldset>
          <button
            className="site-button"
            disabled={
              action.busy ||
              !clanName.trim() ||
              Object.values(copy).some((text) => !text.trim()) ||
              (enabled === saved.hardcoreEnabled &&
                clanName.trim() === saved.clanName &&
                JSON.stringify(copy) ===
                  JSON.stringify(saved.copy ?? defaultSiteCopy))
            }
          >
            Save site settings
          </button>
        </form>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
      <ClanApiKeySettings
        client={client}
        session={session}
        onAccessLost={onAccessLost}
      />
      <ClanLogoSettings
        client={client}
        session={session}
        onAccessLost={onAccessLost}
        onSaved={onBrandingSaved}
      />
    </section>
  );
}

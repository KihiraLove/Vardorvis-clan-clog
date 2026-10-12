/** Independent mode appearance, with shared revision-checked administrator writes. */
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
  hardcore = false,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  onSaved?: ((settings: SiteSettings) => void) | undefined;
  onBrandingSaved: (branding: Branding) => void;
  hardcore?: boolean;
}) {
  const [saved, setSaved] = useState<SiteSettings>();
  const [enabled, setEnabled] = useState(false);
  const [clanName, setClanName] = useState('');
  const [copy, setCopy] = useState<SiteCopy>({ ...defaultSiteCopy });
  const [readError, setReadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const apply = (value: SiteSettings) => {
    const appearance = hardcore ? value.hardcore : value;
    setSaved(value);
    setEnabled(value.hardcoreEnabled);
    setClanName(appearance?.clanName ?? value.clanName);
    setCopy(appearance?.copy ?? { ...defaultSiteCopy });
  };
  useEffect(() => {
    let active = true;
    setSaved(undefined);
    setReadError(undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    void client
      .settings(controller.signal)
      .then((value) => {
        if (active && !controller.signal.aborted) apply(value);
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
        setReadError('Site settings are unavailable. Reload to try again.');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh, onAccessLost, hardcore]);
  return (
    <section className="admin-panel">
      <h2>{hardcore ? 'Hardcore worlds settings' : 'Site settings'}</h2>
      <ClanLogoSettings
        client={client}
        session={session}
        onAccessLost={onAccessLost}
        onSaved={onBrandingSaved}
        hardcore={hardcore}
      />
      <p>
        {hardcore
          ? 'Configure the hardcore appearance while worlds are hidden. Enabling the switch shows the skull; disabling it preserves your settings and recorded collections.'
          : 'Configure the regular site appearance. The clan name and API key are shared by all RuneLite submissions.'}
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
                  hardcore ? undefined : clanName.trim(),
                  hardcore ? undefined : parseSiteCopy(copy),
                  hardcore
                    ? { clanName: clanName.trim(), copy: parseSiteCopy(copy) }
                    : undefined,
                );
                if (!signal.aborted) {
                  apply(value);
                  onSaved?.(value);
                  action.setMessage(
                    hardcore
                      ? 'Hardcore worlds settings saved.'
                      : 'Site settings saved.',
                  );
                }
              },
              async (signal) => {
                const value = await client.settings(signal);
                if (!signal.aborted) {
                  apply(value);
                  onSaved?.(value);
                }
              },
            );
          }}
        >
          <label>
            {hardcore ? 'Displayed clan name' : 'Clan name'}
            <input
              required
              maxLength={80}
              value={clanName}
              disabled={action.busy}
              onChange={(event) => setClanName(event.target.value)}
            />
          </label>
          <p className="admin-note">
            {hardcore
              ? 'Shown when viewing hardcore worlds. Submissions still use the clan name in Site settings.'
              : 'Shown on the regular website and required for all RuneLite submissions.'}
          </p>
          {hardcore && (
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={enabled}
                disabled={action.busy}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enable hardcore worlds
            </label>
          )}
          <fieldset className="site-copy-fields">
            <legend>Website text</legend>
            {(
              [
                ['collectionTitle', 'Collection log title'],
                ['collectionCaption', 'Collection log caption'],
                ['xpTitle', 'XP section title'],
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
                clanName.trim() ===
                  (hardcore
                    ? (saved.hardcore?.clanName ?? saved.clanName)
                    : saved.clanName) &&
                JSON.stringify(copy) ===
                  JSON.stringify(
                    (hardcore ? saved.hardcore?.copy : saved.copy) ??
                      defaultSiteCopy,
                  ))
            }
          >
            {hardcore ? 'Save hardcore settings' : 'Save site settings'}
          </button>
        </form>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
      {!hardcore && (
        <ClanApiKeySettings
          client={client}
          session={session}
          onAccessLost={onAccessLost}
        />
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { AdminRequestError } from './admin-api.ts';
import {
  defaultBranding,
  validateLogoFile,
  type Branding,
} from './branding.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
export function ClanLogoSettings({
  client,
  session,
  onAccessLost,
  onSaved,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  onSaved: (branding: Branding) => void;
}) {
  const [saved, setSaved] = useState<Branding>();
  const [file, setFile] = useState<File>();
  const [readError, setReadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [inputVersion, setInputVersion] = useState(0);
  const action = useAdminAction(onAccessLost);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSaved(undefined);
    setReadError(false);
    void client
      .branding(controller.signal)
      .then((value) => {
        if (active && !controller.signal.aborted) setSaved(value);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (
          failure instanceof AdminRequestError &&
          [401, 403].includes(failure.status)
        )
          onAccessLost();
        else setReadError(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [client, refresh, onAccessLost]);
  const reload = async (signal: AbortSignal) => {
    const value = await client.branding(signal);
    if (!signal.aborted) {
      setSaved(value);
      onSaved(value);
    }
  };
  const save = (reset: boolean) => {
    if (!saved || (!reset && !file)) return;
    void action.execute(async (signal) => {
      if (file && !reset) validateLogoFile(file);
      const value = await client.saveLogo(
        reset ? null : file!,
        saved.revision,
        session.csrfToken,
        signal,
      );
      if (!signal.aborted) {
        setSaved(value);
        onSaved(value);
        setFile(undefined);
        setInputVersion((n) => n + 1);
        action.setMessage(
          reset
            ? 'Default clan logo restored.'
            : 'Clan logo and website icon saved.',
        );
      }
    }, reload);
  };
  return (
    <div className="clan-logo-settings">
      <h3>Clan logo</h3>
      <p>
        Upload a JPEG, PNG, GIF, WebP, SVG, AVIF or TIFF image up to 10 MiB. GIF
        and animated WebP logos animate; the website icon uses the first frame.
        Large images are resized to fit. Source images must be at most 8192
        pixels per side, 300 frames and 64 megapixels across all frames.
      </p>
      {readError && (
        <p role="alert">
          Clan logo settings are unavailable.{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>
            Retry logo settings
          </button>
        </p>
      )}
      {saved && (
        <>
          <img
            className="clan-logo"
            src={saved.logoPath}
            alt="Current clan logo"
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save(false);
            }}
          >
            <label>
              Logo image
              <input
                key={inputVersion}
                type="file"
                accept="image/*,.avif,.tif,.tiff"
                disabled={action.busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  action.setError(undefined);
                  action.setMessage(undefined);
                }}
              />
            </label>
            <button className="site-button" disabled={action.busy || !file}>
              Save clan logo
            </button>
            <button
              type="button"
              className="site-button"
              disabled={
                action.busy || saved.logoPath === defaultBranding.logoPath
              }
              onClick={() => save(true)}
            >
              Restore default logo
            </button>
          </form>
        </>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </div>
  );
}

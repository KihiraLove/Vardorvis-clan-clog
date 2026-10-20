import { useEffect, useState } from 'react';
import { classifyAccessFailure } from './admin-session.ts';
import {
  defaultBranding,
  validateLogoFile,
  type Branding,
} from './branding.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import { useAdminAction } from './use-admin-action.ts';
import { usePreparedAdminData, useAdminDraft } from './admin-route-data.ts';
export function ClanLogoSettings({
  client,
  session,
  onAccessLost,
  onSaved,
  hardcore = false,
}: {
  client: AdminClient;
  session: AdminSession;
  onAccessLost: () => void;
  onSaved: (branding: Branding) => void;
  hardcore?: boolean;
}) {
  const initial = usePreparedAdminData()?.branding;
  const [saved, setSaved] = useState<Branding | undefined>(initial);
  const [file, setFile] = useState<File>();
  const [readError, setReadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [inputVersion, setInputVersion] = useState(0);
  const action = useAdminAction(onAccessLost);
  const editable = session.role === 'admin';
  useAdminDraft(!!file, action.busy);
  useEffect(() => {
    if (initial && refresh === 0) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setSaved(undefined);
    setReadError(false);
    void client
      .branding(controller.signal, hardcore)
      .then((value) => {
        if (active && !controller.signal.aborted) setSaved(value);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (classifyAccessFailure(failure) === 'expired') onAccessLost();
        else setReadError(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [client, refresh, onAccessLost, hardcore]);
  const reload = async (signal: AbortSignal) => {
    const value = await client.branding(signal, hardcore);
    if (!signal.aborted) {
      setSaved(value);
      onSaved(value);
    }
  };
  const save = (reset: boolean) => {
    if (!editable || !saved || (!reset && !file)) return;
    void action.execute(async (signal) => {
      if (file && !reset) validateLogoFile(file);
      const value = await client.saveLogo(
        reset ? null : file!,
        saved.revision,
        session.csrfToken,
        signal,
        hardcore,
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
        JPEG, PNG, GIF, WebP, SVG, AVIF or TIFF up to 10MiB, maximum 8192x8193
        pixels
      </p>
      {readError && (
        <p role="alert">
          Clan logo settings are unavailable.{' '}
          <button onClick={() => setRefresh((n) => n + 1)}>
            Retry logo settings
          </button>
        </p>
      )}
      <div className="clan-logo-preview" aria-busy={!saved && !readError}>
        {saved ? (
          <img
            className="clan-logo"
            src={saved.logoPath}
            alt="Current clan logo"
          />
        ) : (
          <div className="clan-logo-placeholder" aria-hidden="true" />
        )}
      </div>
      <form
        aria-busy={!saved && !readError}
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
            disabled={!editable || action.busy || !saved}
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              action.setError(undefined);
              action.setMessage(undefined);
            }}
          />
        </label>
        <button
          className="site-button"
          disabled={!editable || action.busy || !saved || !file}
        >
          Save clan logo
        </button>
        <button
          type="button"
          className="site-button"
          disabled={
            !editable ||
            action.busy ||
            !saved ||
            saved.logoPath === defaultBranding.logoPath
          }
          onClick={() => save(true)}
        >
          Restore default logo
        </button>
      </form>
      {action.error && <p role="alert">{action.error}</p>}
      {action.message && <p role="status">{action.message}</p>}
    </div>
  );
}

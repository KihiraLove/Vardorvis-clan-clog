import { useEffect, useState } from 'react';
import { classifyAccessFailure } from './admin-session.ts';
import { AdminRequestError } from './admin-api.ts';
import {
  defaultBranding,
  validateLogoFile,
  type Branding,
} from './branding.ts';
import type { AdminClient } from './admin-model.ts';
import { usePreparedAdminData } from './admin-route-data.ts';

/** Logo and settings share one Save action; failed uploads retain their draft. */
export function useClanLogoDraft(
  client: AdminClient,
  onAccessLost: () => void,
  onSaved: (value: Branding) => void,
  csrf: string,
  hardcore: boolean,
) {
  const initial = usePreparedAdminData()?.branding;
  const [saved, setSaved] = useState<Branding | undefined>(initial);
  const [file, setFile] = useState<File | null>();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [inputVersion, setInputVersion] = useState(0);
  useEffect(() => {
    if (initial && refresh === 0) return;
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
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
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh, onAccessLost, hardcore]);
  useEffect(() => {
    if (!file) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const discard = () => {
    setFile(undefined);
    setError(undefined);
    setInputVersion((n) => n + 1);
  };
  return {
    saved,
    error,
    readError,
    inputVersion,
    dirty: file !== undefined,
    previewPath:
      file === null ? defaultBranding.logoPath : (preview ?? saved?.logoPath),
    retry: () => setRefresh((n) => n + 1),
    discard,
    select: (next: File | undefined) => {
      setError(undefined);
      setFile(next);
      try {
        if (next) validateLogoFile(next);
      } catch (failure) {
        setError((failure as Error).message);
      }
    },
    restoreDefault: () => {
      setFile(saved?.logoPath === defaultBranding.logoPath ? undefined : null);
      setError(undefined);
      setInputVersion((n) => n + 1);
    },
    save: async (signal: AbortSignal) => {
      if (file === undefined) return;
      if (!saved)
        throw new Error(
          'Clan logo settings are unavailable. Retry logo settings.',
        );
      if (file) validateLogoFile(file);
      try {
        const value = await client.saveLogo(
          file,
          saved.revision,
          csrf,
          signal,
          hardcore,
        );
        if (!signal.aborted) {
          setSaved(value);
          onSaved(value);
          discard();
        }
      } catch (failure) {
        if (failure instanceof AdminRequestError && failure.status === 409) {
          const value = await client.branding(signal, hardcore);
          if (!signal.aborted) {
            setSaved(value);
            onSaved(value);
          }
        }
        throw failure;
      }
    },
  };
}

export function ClanLogoSettings({
  draft,
  disabled,
}: {
  draft: ReturnType<typeof useClanLogoDraft>;
  disabled: boolean;
}) {
  return (
    <div className="clan-logo-settings">
      <h3>Clan logo</h3>
      {draft.readError && (
        <p role="alert">
          Clan logo settings are unavailable.{' '}
          <button type="button" onClick={draft.retry}>
            Retry logo settings
          </button>
        </p>
      )}
      <div
        className="clan-logo-preview"
        aria-busy={!draft.saved && !draft.readError}
      >
        {draft.saved ? (
          <img
            className="clan-logo"
            src={draft.previewPath}
            alt="Current clan logo"
          />
        ) : (
          <div className="clan-logo-placeholder" aria-hidden="true" />
        )}
      </div>
      <p>
        JPEG, PNG, GIF, WebP, SVG, AVIF or TIFF up to 10MiB, maximum 8192x8193
        pixels
      </p>
      <input
        key={draft.inputVersion}
        type="file"
        aria-label="Logo image"
        accept="image/*,.avif,.tif,.tiff"
        disabled={disabled || !draft.saved}
        onChange={(event) => draft.select(event.target.files?.[0])}
      />
      <button
        type="button"
        className="site-button"
        disabled={
          disabled ||
          !draft.saved ||
          (!draft.dirty && draft.saved.logoPath === defaultBranding.logoPath)
        }
        onClick={draft.restoreDefault}
      >
        Restore default logo
      </button>
      {draft.error && <p role="alert">{draft.error}</p>}
    </div>
  );
}

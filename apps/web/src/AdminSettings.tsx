/** Independent mode appearance, with shared revision-checked administrator writes. */
import { useEffect, useState } from 'react';
import { ClanLogoSettings } from './ClanLogoSettings.tsx';
import type { Branding } from './branding.ts';
import { classifyAccessFailure } from './admin-session.ts';
import type { AdminClient } from './admin-model.ts';
import type { AdminSession } from './xp-model.ts';
import type { SiteSettings } from './site-settings.ts';
import { useAdminAction } from './use-admin-action.ts';
import { defaultSiteCopy, parseSiteCopy, type SiteCopy } from '@clog/domain';
import { usePreparedAdminData, useAdminDraft } from './admin-route-data.ts';
import {
  defaultSubmissionHelp,
  parseSubmissionHelp,
  submissionHelpMaxBytes,
} from '@clog/domain';
import { SubmissionHelpContent } from './SubmissionHelp.tsx';
import { defaultEventHighlight, defaultHardcoreHighlight } from '@clog/domain';
import {
  HighlightPicker,
  highlightDraft,
  draftHighlight,
} from './HighlightPicker.tsx';
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
  const initial = usePreparedAdminData()?.settings;
  const initialAppearance = hardcore ? initial?.hardcore : initial;
  const defaultHighlight = hardcore
    ? defaultHardcoreHighlight
    : defaultEventHighlight;
  const savedHighlight = (value: SiteSettings | undefined) =>
    (hardcore ? value?.hardcoreHighlight : value?.eventHighlight) ??
    defaultHighlight;
  const [highlight, setHighlight] = useState(() =>
    highlightDraft(savedHighlight(initial)),
  );
  const colour = draftHighlight(highlight);
  const [saved, setSaved] = useState<SiteSettings | undefined>(initial);
  const [enabled, setEnabled] = useState(initial?.hardcoreEnabled ?? false);
  const [clanName, setClanName] = useState(
    initialAppearance?.clanName ?? initial?.clanName ?? '',
  );
  const [copy, setCopy] = useState<SiteCopy>(
    initialAppearance?.copy ?? { ...defaultSiteCopy },
  );
  const [readError, setReadError] = useState<string>();
  const [help, setHelp] = useState(
    initial?.howToSubmitMarkdown ?? defaultSubmissionHelp,
  );
  const [preview, setPreview] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const action = useAdminAction(onAccessLost);
  const releaseAction = useAdminAction(onAccessLost);
  const busy = action.busy || releaseAction.busy;
  const editable = session.role === 'admin';
  const savedAppearance = hardcore ? saved?.hardcore : saved;
  const helpBytes = new TextEncoder().encode(help).length;
  const helpInvalid =
    !hardcore && (helpBytes > submissionHelpMaxBytes || help.includes('\0'));
  const dirty =
    !!saved &&
    (enabled !== saved.hardcoreEnabled ||
      JSON.stringify(highlight) !==
        JSON.stringify(highlightDraft(savedHighlight(saved))) ||
      clanName !== (savedAppearance?.clanName ?? saved.clanName) ||
      JSON.stringify(copy) !==
        JSON.stringify(savedAppearance?.copy ?? defaultSiteCopy) ||
      (!hardcore &&
        help !== (saved.howToSubmitMarkdown ?? defaultSubmissionHelp)));
  useAdminDraft(dirty, busy);
  const apply = (value: SiteSettings) => {
    const appearance = hardcore ? value.hardcore : value;
    setSaved(value);
    setHighlight(highlightDraft(savedHighlight(value)));
    setEnabled(value.hardcoreEnabled);
    setClanName(appearance?.clanName ?? value.clanName);
    setCopy(appearance?.copy ?? { ...defaultSiteCopy });
    setHelp(value.howToSubmitMarkdown ?? defaultSubmissionHelp);
  };
  useEffect(() => {
    if (initial && refresh === 0) return;
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
        if (classifyAccessFailure(failure) === 'expired') {
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
    <>
      {hardcore && (
        <section className="admin-panel hardcore-release-setting">
          <h2 id="hardcore-release-title">Enable hardcore worlds</h2>
          <button
            type="button"
            role="switch"
            className="site-button admin-toggle"
            aria-labelledby="hardcore-release-title"
            aria-checked={enabled}
            disabled={busy || !saved || !editable}
            onClick={() => {
              if (!saved || !editable) return;
              const next = !enabled;
              void releaseAction.execute(
                async (signal) => {
                  const value = await client.saveSettings(
                    next,
                    saved.revision,
                    session.csrfToken,
                    signal,
                  );
                  if (!signal.aborted) {
                    setSaved(value);
                    setEnabled(value.hardcoreEnabled);
                    onSaved?.(value);
                    releaseAction.setMessage(
                      next
                        ? 'Hardcore worlds enabled.'
                        : 'Hardcore worlds disabled.',
                    );
                  }
                },
                async (signal) => {
                  const value = await client.settings(signal);
                  if (!signal.aborted) {
                    setSaved(value);
                    setEnabled(value.hardcoreEnabled);
                    onSaved?.(value);
                  }
                },
              );
            }}
          >
            {enabled ? 'On' : 'Off'}
          </button>
          {releaseAction.error && <p role="alert">{releaseAction.error}</p>}
          {releaseAction.message && (
            <p role="status">{releaseAction.message}</p>
          )}
        </section>
      )}
      <section className="admin-panel">
        <h2>{hardcore ? 'Hardcore worlds settings' : 'Site settings'}</h2>
        {!editable && <p>Only the administrator can change these settings.</p>}
        <ClanLogoSettings
          client={client}
          session={session}
          onAccessLost={onAccessLost}
          onSaved={onBrandingSaved}
          hardcore={hardcore}
        />
        {readError && (
          <p role="alert">
            {readError}{' '}
            <button onClick={() => setRefresh((n) => n + 1)}>
              Retry settings
            </button>
          </p>
        )}
        <form
          id={hardcore ? 'hardcore-site-settings' : 'regular-site-settings'}
          aria-busy={!saved && !readError}
          onSubmit={(event) => {
            event.preventDefault();
            if (!saved || !editable || helpInvalid || !colour) return;
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
                  hardcore ? undefined : parseSubmissionHelp(help),
                  hardcore
                    ? { hardcoreHighlight: colour }
                    : { eventHighlight: colour },
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
            Displayed clan name
            <input
              required
              maxLength={80}
              value={clanName}
              disabled={busy || !saved || !editable}
              onChange={(event) => setClanName(event.target.value)}
            />
          </label>
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
                  disabled={busy || !saved || !editable}
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
          <HighlightPicker
            title={
              hardcore
                ? 'Hardcore collection highlight'
                : 'Event collection highlight'
            }
            value={highlight}
            onChange={setHighlight}
            disabled={busy || !saved || !editable}
          />
          {!hardcore && (
            <fieldset className="site-copy-fields submission-help-settings">
              <legend>Submission help</legend>
              <label htmlFor="submission-help-markdown">
                How to submit (Markdown)
              </label>
              <textarea
                id="submission-help-markdown"
                rows={14}
                value={help}
                disabled={busy || !saved || !editable}
                aria-describedby="submission-help-limit"
                aria-invalid={helpInvalid || undefined}
                onChange={(event) => setHelp(event.target.value)}
              />
              <p id="submission-help-limit">
                {helpBytes.toLocaleString()} / 32,768 bytes. Supports Markdown
                headings, lists, links, emphasis and code blocks. Empty text
                uses the default instructions.
              </p>
              {helpInvalid && (
                <p role="alert">
                  Use at most 32 KiB of UTF-8 text with no NUL characters.
                </p>
              )}
              <button
                type="button"
                className="site-button"
                aria-expanded={preview}
                onClick={() => setPreview(!preview)}
              >
                {preview ? 'Hide preview' : 'Preview instructions'}
              </button>
              {preview && (
                <section aria-label="Submission help preview">
                  <SubmissionHelpContent text={help} />
                </section>
              )}
            </fieldset>
          )}
          <button
            className="site-button"
            disabled={
              !editable ||
              !dirty ||
              helpInvalid ||
              !colour ||
              busy ||
              !saved ||
              !clanName.trim() ||
              Object.values(copy).some((text) => !text.trim())
            }
          >
            {hardcore ? 'Save hardcore settings' : 'Save site settings'}
          </button>
          <button
            type="button"
            className="site-button"
            disabled={!dirty || busy || !saved || !editable}
            onClick={() => {
              if (saved) apply(saved);
              action.setError(undefined);
              action.setMessage(undefined);
            }}
          >
            Discard changes
          </button>
        </form>
        {action.error && <p role="alert">{action.error}</p>}
        {action.message && <p role="status">{action.message}</p>}
      </section>
    </>
  );
}

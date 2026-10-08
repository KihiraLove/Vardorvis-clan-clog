/** Session-gated preview/apply workflow with expiry, correction acknowledgment and history. */
import { useEffect, useRef, useState } from 'react';
import {
  competitionUrl,
  exactXp,
  signedXp,
  skillName,
  type AdminSession,
  type ImportEntry,
  type ImportPreview,
  type XpClient,
} from './xp-model.ts';
import { XpRequestError } from './xp-api.ts';
import { xpDate, xpTime } from './XpTables.tsx';

export function XpAdmin({
  client,
  onApplied,
  previewMode,
}: {
  client: XpClient;
  onApplied: () => void;
  previewMode: boolean;
}) {
  const [session, setSession] = useState<AdminSession | null>();
  const [accessError, setAccessError] = useState<string>();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<ImportPreview>();
  const [history, setHistory] = useState<ImportEntry[]>([]);
  const [historyError, setHistoryError] = useState<string>();
  const [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [expired, setExpired] = useState(false);
  const operation = useRef<AbortController | undefined>(undefined),
    requestKey = useRef('');
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let active = true;
    void client
      .session(controller.signal)
      .then(async (next) => {
        if (!active) return;
        setSession(next);
        if (next) {
          try {
            const rows = await client.history(controller.signal);
            if (active) setHistory(rows);
          } catch {
            if (active) setHistoryError('Import history could not be loaded.');
          }
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setAccessError(
            failure instanceof XpRequestError
              ? failure.message
              : 'Could not check admin access. Reload to try again.',
          );
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      controller.abort();
      operation.current?.abort();
      operation.current = undefined;
      clearTimeout(timeout);
    };
  }, [client]);
  useEffect(() => {
    if (!preview) {
      setExpired(false);
      return;
    }
    const check = () => setExpired(Date.now() >= Date.parse(preview.expiresAt));
    check();
    const interval = window.setInterval(check, 1000);
    return () => clearInterval(interval);
  }, [preview]);
  const execute = async (apply: boolean) => {
    if (!session || busy) return;
    let canonical: string;
    try {
      canonical = competitionUrl(url).url;
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const controller = new AbortController();
    operation.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      if (apply && preview) {
        const result = await client.apply(
          preview,
          session.csrfToken,
          requestKey.current,
          controller.signal,
          acknowledged,
        );
        if (controller.signal.aborted) return;
        setMessage(
          result.outcome === 'unchanged'
            ? 'Unchanged — no XP was added.'
            : 'Competition imported. Recorded skill totals are updated.',
        );
        setPreview(undefined);
        setAcknowledged(false);
        onApplied();
        try {
          const rows = await client.history(controller.signal);
          if (operation.current !== controller || controller.signal.aborted)
            return;
          setHistory(rows);
          setHistoryError(undefined);
        } catch {
          if (operation.current === controller)
            setHistoryError(
              'Import succeeded, but history could not be refreshed.',
            );
        }
      } else {
        setPreview(undefined);
        setAcknowledged(false);
        const result = await client.preview(
          canonical,
          session.csrfToken,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        // One key per preview is reused after timeouts where the apply outcome is uncertain.
        requestKey.current = crypto.randomUUID();
        setPreview(result);
      }
    } catch (failure) {
      if (operation.current === controller) {
        setError(
          failure instanceof XpRequestError
            ? failure.message
            : controller.signal.aborted
              ? 'The request timed out. Retry to check the result safely.'
              : failure instanceof Error
                ? failure.message
                : 'Could not complete the import.',
        );
        if (
          failure instanceof XpRequestError &&
          [401, 403, 409].includes(failure.status)
        )
          setPreview(undefined);
        if (
          failure instanceof XpRequestError &&
          [401, 403].includes(failure.status)
        )
          setSession(null);
      }
    } finally {
      clearTimeout(timeout);
      if (operation.current === controller) setBusy(false);
    }
  };
  if (accessError)
    return (
      <section className="xp-panel">
        <h2>Admin access unavailable</h2>
        <p role="alert">{accessError}</p>
      </section>
    );
  if (session === undefined) return <p role="status">Checking admin access…</p>;
  if (session === null)
    return (
      <section className="xp-panel">
        <h2>Admin sign-in required</h2>
        <p>
          Sign in with the admin password to import or refresh competition XP.
        </p>
        <a className="site-button" href="/admin">
          Admin password sign-in
        </a>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const correction = preview?.changes.some((c) => BigInt(c.change) < 0n);
  return (
    <section className="xp-panel xp-admin" aria-labelledby="xp-admin-title">
      <div className="xp-section-heading">
        <h2 id="xp-admin-title">Import competition</h2>
        <span>{session.displayName}</span>
      </div>
      <p>
        Add an event by its Wise Old Man link. Review its name, skill or
        all-skill scope, and gained XP before applying.
      </p>
      {session.development && (
        <p className="xp-note" role="status">
          Local test admin — no Discord login. Imported XP is stored in the
          separate disposable local database.
        </p>
      )}
      {previewMode && (
        <p className="xp-note">
          Review only: use sample competition 1001 or 1002. No live imports are
          made.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void execute(false);
        }}
      >
        <label htmlFor="competition-url">Wise Old Man competition link</label>
        <div className="xp-import-field">
          <input
            id="competition-url"
            type="url"
            required
            placeholder="https://wiseoldman.net/competitions/1001"
            value={url}
            disabled={busy}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(undefined);
              setMessage(undefined);
              setError(undefined);
            }}
          />
          <button type="submit" className="site-button" disabled={busy}>
            {busy ? 'Please wait…' : 'Preview competition'}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="xp-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="xp-success">
          {message}
        </p>
      )}
      {preview && (
        <div className="xp-import-preview">
          <h3>{preview.competition.title}</h3>
          <p>
            {xpDate(preview.competition.startsAt)} –{' '}
            {xpDate(preview.competition.endsAt)} ·{' '}
            <a
              href={preview.competition.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View competition on WOM
            </a>
          </p>
          <div className="xp-table-scroll">
            <table className="xp-table">
              <caption>Change to cumulative site totals</caption>
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col">Recorded before</th>
                  <th scope="col">After refresh</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.skill}>
                    <th scope="row">{skillName(c.skill)}</th>
                    <td>{exactXp(c.before)} XP</td>
                    <td>{exactXp(c.after)} XP</td>
                    <td
                      className={
                        BigInt(c.change) < 0n ? 'xp-error' : 'xp-success'
                      }
                    >
                      {signedXp(c.change)} XP
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Skills:{' '}
            {preview.competition.skills.length === 1
              ? skillName(preview.competition.skills[0]!)
              : 'All skills'}
          </p>
          {preview.warnings.map((warning) => (
            <p className="xp-note" key={warning}>
              {warning}
            </p>
          ))}
          {correction && (
            <label className="xp-confirm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I reviewed the corrections that reduce recorded XP.
            </label>
          )}
          {expired && (
            <p role="alert">Preview expired. Preview this competition again.</p>
          )}
          <button
            type="button"
            className="site-button"
            disabled={busy || expired || (correction && !acknowledged)}
            onClick={() => {
              void execute(true);
            }}
          >
            Apply import
          </button>
        </div>
      )}
      <details className="xp-history">
        <summary>Import history ({history.length})</summary>
        {historyError && <p role="alert">{historyError}</p>}
        {!history.length && <p>No imports recorded yet.</p>}
        <ol>
          {history.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.title}</strong>
              <p>
                {xpTime(entry.importedAt)} · {entry.actorName} · {entry.outcome}
              </p>
              <p>
                {entry.changes
                  .map(
                    (c) =>
                      skillName(c.skill) + ' ' + signedXp(c.change) + ' XP',
                  )
                  .join(' · ')}
              </p>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

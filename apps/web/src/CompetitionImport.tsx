import { useEffect, useRef, useState } from 'react';
import { classifyAccessFailure } from './admin-session.ts';
import {
  CompetitionRequestError,
  type CompetitionClient,
  type CompetitionImportPreview,
} from './competition-api.ts';
import { exactXp, signedXp, skillName, type AdminSession } from './xp-model.ts';
import { localScheduleLabel, utcScheduleLabel } from './schedule-time.ts';
import { useAdminDraft } from './admin-route-data.ts';
export function CompetitionImport({
  client,
  session,
  onApplied,
  onAccessLost,
}: {
  client: CompetitionClient;
  session: AdminSession;
  onApplied: () => void;
  onAccessLost: () => void;
}) {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<CompetitionImportPreview>(),
    [pages, setPages] = useState<string[]>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>(),
    [ack, setAck] = useState(false),
    [expired, setExpired] = useState(false),
    [search, setSearch] = useState('');
  const key = useRef(''),
    operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    const check = () =>
      setExpired(!!preview && Date.now() >= Date.parse(preview.expiresAt));
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [preview]);
  const dirty =
    !!preview &&
    JSON.stringify(pages?.slice().sort()) !==
      JSON.stringify(preview.pageIds.slice().sort());
  useAdminDraft(!!preview || dirty, busy);
  const execute = async (apply: boolean) => {
    if (busy) return;
    const controller = new AbortController();
    operation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      if (apply && preview) {
        const r = await client.apply(
          preview,
          session.csrfToken,
          key.current,
          ack,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setMessage(
          r.outcome === 'unchanged'
            ? 'Unchanged. No gains or schedules were added.'
            : preview.action === 'import-metadata'
              ? 'Competition metadata imported. No pages were opened or XP added.'
              : 'Competition imported.',
        );
        setPreview(undefined);
        setPages(undefined);
        onApplied();
      } else {
        const p = await client.preview(
          url,
          session.csrfToken,
          controller.signal,
          pages,
        );
        if (controller.signal.aborted) return;
        setPreview(p);
        setPages(p.pageIds);
        setAck(false);
        key.current = crypto.randomUUID();
      }
    } catch (e) {
      if (controller.signal.aborted) {
        setError(
          'Request timed out. Retry Apply to check the committed result safely.',
        );
      } else {
        const failure = classifyAccessFailure(e);
        if (failure === 'expired') {
          setPreview(undefined);
          setPages(undefined);
          onAccessLost();
          return;
        }
        setError(
          failure === 'denied'
            ? 'Your account is not allowed to perform this competition import.'
            : e instanceof CompetitionRequestError
              ? e.message
              : e instanceof Error
                ? e.message
                : 'Import failed.',
        );
      }
      if (
        e instanceof CompetitionRequestError &&
        [401, 403, 409].includes(e.status)
      ) {
        setPreview(undefined);
        setPages(undefined);
      }
    } finally {
      clearTimeout(timeout);
      if (operation.current === controller) setBusy(false);
    }
  };
  const correction = preview?.changes.some((c) => BigInt(c.change) < 0n);
  return (
    <section className="competition-import">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void execute(false);
        }}
      >
        <fieldset disabled={busy} className="admin-fieldset">
          <label className="admin-field-label">
            Wise Old Man competition link
            <input
              className="admin-input"
              type="url"
              required
              value={url}
              placeholder="https://wiseoldman.net/competitions/123"
              onChange={(e) => {
                setUrl(e.target.value);
                setPreview(undefined);
                setPages(undefined);
              }}
            />
          </label>
          <button className="site-button" disabled={!url}>
            {busy ? 'Please wait…' : 'Preview competition'}
          </button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="admin-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="admin-success">
          {message}
        </p>
      )}
      {preview && (
        <div className="xp-import-preview">
          <h4>{preview.competition.title}</h4>
          <p>
            Detected kind: {preview.competition.kind} · {preview.lifecycle} ·{' '}
            {preview.competition.metrics.join(', ')}
          </p>
          <a
            href={preview.competition.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View competition on WOM
          </a>
          <p>
            Start: {localScheduleLabel(preview.competition.startsAt)}
            <br />
            <small>{utcScheduleLabel(preview.competition.startsAt)}</small>
            <br />
            End: {localScheduleLabel(preview.competition.endsAt)}
            <br />
            <small>{utcScheduleLabel(preview.competition.endsAt)}</small>
          </p>
          <p>
            {preview.action === 'import-metadata'
              ? 'Import competition metadata only. No pages will be opened and no XP will be added.'
              : preview.action === 'import-results'
                ? 'Import finished results. No opening window will be created.'
                : preview.action === 'preserve-schedule'
                  ? 'Preserve the existing linked schedule.'
                  : preview.action === 'preserve-deletion'
                    ? 'Keep the linked window closed.'
                    : preview.lifecycle === 'running'
                      ? 'Create an opening window starting immediately when Apply commits, ending at the WOM end time.'
                      : 'Create an opening window for the WOM start and end times.'}
          </p>
          {preview.scheduleStartsAt && (
            <p>
              Opening start: {localScheduleLabel(preview.scheduleStartsAt)}
              <br />
              <small>{utcScheduleLabel(preview.scheduleStartsAt)}</small>
            </p>
          )}
          {preview.competition.kind === 'ACTIVITY' &&
            preview.action === 'create-schedule' && (
              <>
                <label className="admin-field-label">
                  Find opening pages
                  <input
                    className="admin-input"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <fieldset
                  className="admin-choice-fieldset schedule-page-list"
                  disabled={busy}
                >
                  <legend>Opening pages</legend>
                  {preview.pages
                    .filter((p) =>
                      p.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((p) => (
                      <label
                        className="admin-checkbox admin-checkbox--touch"
                        key={p.id}
                      >
                        <input
                          className="admin-check"
                          type="checkbox"
                          checked={pages?.includes(p.id) ?? false}
                          onChange={(e) =>
                            setPages(
                              e.target.checked
                                ? [...(pages ?? []), p.id]
                                : (pages ?? []).filter((id) => id !== p.id),
                            )
                          }
                        />
                        {p.name}
                      </label>
                    ))}
                </fieldset>
                <p>
                  {pages?.length ?? 0} pages selected.
                  {dirty ? ' Update the preview to confirm these pages.' : ''}
                </p>
                {dirty && (
                  <button
                    className="site-button"
                    disabled={busy}
                    onClick={() => {
                      void execute(false);
                    }}
                  >
                    Update preview
                  </button>
                )}
              </>
            )}
          {preview.competition.kind === 'ACTIVITY' &&
            preview.action === 'preserve-schedule' && (
              <p>
                Pages:{' '}
                {preview.pageIds
                  .map(
                    (id) => preview.pages.find((p) => p.id === id)?.name ?? id,
                  )
                  .join(', ')}
              </p>
            )}
          {preview.lifecycle === 'finished' && (
            <details>
              <summary>
                Eligible participants ({preview.participants.length})
              </summary>
              <ol>
                {preview.participants.map((p) => (
                  <li key={p.playerId}>
                    {p.displayName}: {exactXp(p.gained)}{' '}
                    {preview.competition.kind === 'SKILL' ? 'XP' : 'gained'}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {!!preview.changes.length && (
            <div className="xp-table-scroll">
              <table className="xp-table">
                <caption>Change to cumulative site totals</caption>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.skill}>
                      <th>{skillName(c.skill)}</th>
                      <td>{exactXp(c.before)} XP</td>
                      <td>{exactXp(c.after)} XP</td>
                      <td>{signedXp(c.change)} XP</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.warnings.map((w) => (
            <p className="admin-note" key={w}>
              {w}
            </p>
          ))}
          {correction && (
            <label className="admin-checkbox admin-checkbox--touch">
              <input
                className="admin-check"
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I reviewed the corrections that reduce recorded XP.
            </label>
          )}
          {expired && (
            <p role="alert" className="admin-error">
              Preview expired. Preview this competition again.
            </p>
          )}
          <button
            className="site-button"
            disabled={
              busy ||
              expired ||
              dirty ||
              (preview.action === 'create-schedule' && !pages?.length) ||
              (correction && !ack)
            }
            onClick={() => {
              void execute(true);
            }}
          >
            Apply import
          </button>
        </div>
      )}
    </section>
  );
}

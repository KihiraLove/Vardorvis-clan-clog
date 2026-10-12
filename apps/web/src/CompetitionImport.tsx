import { useEffect, useRef, useState } from 'react';
import type { CompetitionKind } from '@clog/domain';
import {
  CompetitionRequestError,
  type CompetitionClient,
  type CompetitionImportPreview,
} from './competition-api.ts';
import { exactXp, signedXp, skillName, type AdminSession } from './xp-model.ts';
import { localScheduleLabel, utcScheduleLabel } from './schedule-time.ts';
export function CompetitionImport({
  client,
  session,
  onApplied,
}: {
  client: CompetitionClient;
  session: AdminSession;
  onApplied: () => void;
}) {
  const [url, setUrl] = useState(''),
    [kind, setKind] = useState<CompetitionKind | ''>('');
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
  const execute = async (apply: boolean) => {
    if (!kind || busy) return;
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
            : 'Competition imported.',
        );
        setPreview(undefined);
        setPages(undefined);
        onApplied();
      } else {
        const p = await client.preview(
          url,
          kind,
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
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Import failed.');
      else
        setError(
          'Request timed out. Retry Apply to check the committed result safely.',
        );
      if (
        e instanceof CompetitionRequestError &&
        [401, 403, 409].includes(e.status)
      )
        setPreview(undefined);
    } finally {
      clearTimeout(timeout);
      if (operation.current === controller) setBusy(false);
    }
  };
  const correction = preview?.changes.some((c) => BigInt(c.change) < 0n);
  return (
    <section className="competition-import">
      <h3>Import competition</h3>
      <p>
        Choose SKILL for XP or ACTIVITY for boss/activity results. Future and
        running imports save metadata and an opening window; finished imports
        save final results.
      </p>
      {session.role === 'moderator' && (
        <p>
          Finished SKILL results require the administrator. You can prepare
          skill schedules and import ACTIVITY competitions.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void execute(false);
        }}
      >
        <fieldset disabled={busy} className="admin-fieldset">
          <label>
            Wise Old Man competition link
            <input
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
          <label>
            Competition kind
            <select
              required
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as CompetitionKind);
                setPreview(undefined);
                setPages(undefined);
              }}
            >
              <option value="">Choose SKILL or ACTIVITY</option>
              <option value="SKILL">SKILL — XP</option>
              <option value="ACTIVITY">ACTIVITY — boss/activity</option>
            </select>
          </label>
          <button className="site-button" disabled={!kind || !url}>
            {busy ? 'Please wait…' : 'Preview competition'}
          </button>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {preview && (
        <div className="xp-import-preview">
          <h4>{preview.competition.title}</h4>
          <p>
            {preview.competition.kind} · {preview.lifecycle} ·{' '}
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
            Source start: {localScheduleLabel(preview.competition.startsAt)}
            <br />
            <small>{utcScheduleLabel(preview.competition.startsAt)}</small>
            <br />
            Source end: {localScheduleLabel(preview.competition.endsAt)}
            <br />
            <small>{utcScheduleLabel(preview.competition.endsAt)}</small>
          </p>
          <p>
            {preview.action === 'import-results'
              ? 'Import finished results. No opening window will be created.'
              : preview.action === 'preserve-schedule'
                ? 'Preserve the existing linked schedule.'
                : preview.action === 'preserve-deletion'
                  ? 'Preserve the deleted schedule.'
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
          {preview.action === 'create-schedule' && (
            <>
              <label>
                Find opening pages
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <fieldset className="schedule-page-list" disabled={busy}>
                <legend>Opening pages</legend>
                {preview.pages
                  .filter((p) =>
                    p.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((p) => (
                    <label className="admin-checkbox" key={p.id}>
                      <input
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
          {preview.action === 'preserve-schedule' && (
            <p>
              Pages:{' '}
              {preview.pageIds
                .map((id) => preview.pages.find((p) => p.id === id)?.name ?? id)
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
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I reviewed the corrections that reduce recorded XP.
            </label>
          )}
          {expired && (
            <p role="alert">Preview expired. Preview this competition again.</p>
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

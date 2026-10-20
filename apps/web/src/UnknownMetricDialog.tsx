import { useEffect, useRef, useState } from 'react';
import {
  competitionMetricName,
  parseCustomCompetitionMetric,
  skills,
  type CompetitionMetricResolution,
  type CustomCompetitionMetric,
} from '@clog/domain';

export function UnknownMetricDialog({
  resolution,
  busy,
  error,
  onDiscard,
  onSave,
}: {
  resolution: CompetitionMetricResolution;
  busy: boolean;
  error: string | undefined;
  onDiscard: () => void;
  onSave: (
    definitions: CustomCompetitionMetric[],
    key: string,
  ) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef({ payload: '', key: '' });
  const [rows, setRows] = useState(() =>
    resolution.unknownMetrics.map((metric) => ({
      metric,
      name: competitionMetricName(metric),
      type: '',
      skill: '',
      pageIds: [] as string[],
      search: '',
    })),
  );
  const [validation, setValidation] = useState<string>();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const change = (index: number, fields: Partial<(typeof rows)[number]>) => {
    setRows((old) =>
      old.map((row, i) => (i === index ? { ...row, ...fields } : row)),
    );
    setValidation(undefined);
  };
  return (
    <dialog
      ref={dialog}
      className="unknown-metric-dialog"
      aria-labelledby="unknown-metric-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 && element.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDiscard();
      }}
    >
      <div className="admin-section-heading">
        <h3 id="unknown-metric-title">
          Unknown competition metric{rows.length > 1 ? 's' : ''}
        </h3>
        <button
          type="button"
          className="site-button"
          aria-label="Discard import and close"
          disabled={busy}
          onClick={onDiscard}
        >
          ×
        </button>
      </div>
      <p>
        <a href={resolution.sourceUrl} target="_blank" rel="noreferrer">
          {resolution.title}
        </a>{' '}
        uses metrics that have not been configured yet.
      </p>
      <p>
        Save their definitions for future imports, then review this competition
        before applying. Discarding saves nothing. Saved definitions remain
        available if you later cancel the import.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          try {
            const definitions = rows.map((row) =>
              parseCustomCompetitionMetric({
                metric: row.metric,
                name: row.name,
                type: row.type,
                pageIds: ['BOSS', 'ACTIVITY'].includes(row.type)
                  ? row.pageIds
                  : [],
                ...(row.type === 'SKILL' ? { skill: row.skill } : {}),
              }),
            );
            const payload = JSON.stringify(definitions);
            if (request.current.payload !== payload)
              request.current = { payload, key: crypto.randomUUID() };
            void onSave(definitions, request.current.key);
          } catch (failure) {
            setValidation((failure as Error).message);
          }
        }}
      >
        <fieldset className="admin-fieldset" disabled={busy}>
          {rows.map((row, index) => (
            <fieldset
              key={row.metric}
              className="admin-fieldset metric-definition-fields"
            >
              <legend>Metric: {row.metric}</legend>
              <label className="admin-field-label">
                Display name
                <input
                  className="admin-input"
                  required
                  maxLength={120}
                  value={row.name}
                  onChange={(e) => change(index, { name: e.target.value })}
                />
              </label>
              <label className="admin-field-label">
                Metric type
                <select
                  className="admin-input"
                  required
                  value={row.type}
                  onChange={(e) =>
                    change(index, {
                      type: e.target.value,
                      pageIds: [],
                      skill: '',
                    })
                  }
                >
                  <option value="">Choose a type</option>
                  <option value="BOSS">Activity — boss or raid (kills)</option>
                  <option value="ACTIVITY">Activity — counter (score)</option>
                  <option value="COMPUTED">Activity — computed (hours)</option>
                  <option value="SKILL">Skill — XP</option>
                </select>
              </label>
              {row.type === 'SKILL' && (
                <label className="admin-field-label">
                  XP skill
                  <select
                    className="admin-input"
                    required
                    value={row.skill}
                    onChange={(e) => change(index, { skill: e.target.value })}
                  >
                    <option value="">Choose a supported skill</option>
                    {skills.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <small>
                    Only use this for actual gained XP for the selected skill.
                  </small>
                </label>
              )}
              {['BOSS', 'ACTIVITY'].includes(row.type) && (
                <>
                  <label className="admin-field-label">
                    Search collection log pages
                    <input
                      className="admin-input"
                      type="search"
                      value={row.search}
                      onChange={(e) =>
                        change(index, { search: e.target.value })
                      }
                    />
                  </label>
                  <div
                    className="metric-page-choices"
                    role="group"
                    aria-label={'Pages for ' + row.metric}
                  >
                    {resolution.pages
                      .filter((p) =>
                        p.name.toLowerCase().includes(row.search.toLowerCase()),
                      )
                      .map((p) => (
                        <label
                          key={p.id}
                          className="admin-checkbox admin-checkbox--touch"
                        >
                          <input
                            className="admin-check"
                            type="checkbox"
                            checked={row.pageIds.includes(p.id)}
                            onChange={(e) =>
                              change(index, {
                                pageIds: e.target.checked
                                  ? [...row.pageIds, p.id]
                                  : row.pageIds.filter((id) => id !== p.id),
                              })
                            }
                          />
                          {p.name}
                        </label>
                      ))}
                  </div>
                  <p className="admin-note">
                    Page mapping is optional here. A running or future activity
                    import still needs a page selected before Apply.
                  </p>
                </>
              )}
            </fieldset>
          ))}
          {(validation || error) && (
            <p className="admin-error" role="alert">
              {validation || error}
            </p>
          )}
          <div className="admin-actions">
            <button className="site-button" type="submit">
              {busy
                ? 'Saving…'
                : 'Save metric' +
                  (rows.length > 1 ? 's' : '') +
                  ' and continue'}
            </button>
            <button className="site-button" type="button" onClick={onDiscard}>
              Discard import
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

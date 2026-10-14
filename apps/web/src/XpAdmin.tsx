/** Private paged XP receipts; new imports share the lifecycle-aware competition flow. */
import { useEffect, useRef, useState } from 'react';
import { CompetitionImport } from './CompetitionImport.tsx';
import { classifyAccessFailure } from './admin-session.ts';
import type { CompetitionClient } from './competition-api.ts';
import {
  signedXp,
  exactXp,
  skillName,
  type AdminSession,
  type ImportHistoryPage,
  type XpClient,
} from './xp-model.ts';
import { XpRequestError } from './xp-api.ts';
import { withAbort } from './with-abort.ts';
import { xpTime } from './XpTables.tsx';
import { usePreparedAdminData } from './admin-route-data.ts';
export function XpAdmin({
  client,
  competitionClient,
  onApplied,
  previewMode,
  session,
  onAccessLost,
}: {
  client: XpClient;
  competitionClient: CompetitionClient;
  onApplied: () => void;
  previewMode: boolean;
  session: AdminSession;
  onAccessLost: () => void;
}) {
  const prepared = usePreparedAdminData();
  const preparedRead = useRef(prepared?.kind === 'xp');
  const [error, setError] = useState<string | undefined>(
    prepared?.historyError,
  );
  const [history, setHistory] = useState<ImportHistoryPage | undefined>(
    prepared?.history,
  );
  const revision = useRef(prepared?.history?.revision);
  const [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [loading, setLoading] = useState(
    !preparedRead.current && session.role === 'admin',
  );
  const cursor = cursors.at(-1);
  useEffect(() => {
    if (preparedRead.current) {
      preparedRead.current = false;
      return;
    }
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    // Every read failure clears private rows; a 401 also revokes the shell session.
    setHistory(undefined);
    setError(undefined);
    if (session.role === 'admin') {
      setLoading(true);
      void withAbort(
        client.history(controller.signal, cursor),
        controller.signal,
      )
        .then((page) => {
          if (!active) return;
          if (
            cursor &&
            (page.revision !== revision.current || page.pageCursor !== cursor)
          )
            throw new XpRequestError(409);
          if (page.nextCursor && page.nextCursor === page.pageCursor)
            throw new Error('Inconsistent history page.');
          revision.current = page.revision;
          setHistory(page);
        })
        .catch((failure: unknown) => {
          if (!active) return;
          setHistory(undefined);
          if (classifyAccessFailure(failure) === 'expired') onAccessLost();
          else
            setError(
              classifyAccessFailure(failure) === 'denied'
                ? 'Your account is not allowed to view XP import history.'
                : failure instanceof XpRequestError && failure.status === 409
                  ? 'XP import history changed. Retry to reload the latest first page.'
                  : 'XP import history could not be loaded. Retry to refresh.',
            );
        })
        .finally(() => {
          clearTimeout(timer);
          if (active) setLoading(false);
        });
    } else {
      clearTimeout(timer);
      setLoading(false);
    }
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, session, refresh, cursor, onAccessLost]);
  const reload = () => {
    setHistory(undefined);
    setCursors([undefined]);
    setRefresh((n) => n + 1);
  };
  const rows = history?.imports ?? [];
  return (
    <section className="xp-panel">
      <h2>{previewMode ? 'Preview XP imports' : 'XP competition imports'}</h2>
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="site-button" onClick={reload}>
            Retry XP history
          </button>
        </p>
      )}
      <CompetitionImport
        client={competitionClient}
        session={session}
        onAccessLost={onAccessLost}
        onApplied={() => {
          reload();
          onApplied();
        }}
      />
      {session.role === 'admin' && (
        <details className="xp-history">
          <summary>Import history ({rows.length} on this page)</summary>
          {loading && <p role="status">Loading XP import history…</p>}
          {error ? (
            <p>Import history unavailable.</p>
          ) : (
            !loading && !rows.length && <p>No imports recorded yet.</p>
          )}
          <div className="admin-pagination">
            <button
              type="button"
              className="site-button"
              disabled={loading || !!error || !history || cursors.length === 1}
              aria-busy={loading}
              onClick={() => {
                setHistory(undefined);
                setCursors((values) => values.slice(0, -1));
              }}
            >
              Newer imports
            </button>
            <span>History page {cursors.length}</span>
            <button
              type="button"
              className="site-button"
              disabled={loading || !!error || !history?.nextCursor}
              aria-busy={loading}
              onClick={() => {
                const page = history!;
                setHistory(undefined);
                setCursors((values) => [
                  ...values.slice(0, -1),
                  page.pageCursor,
                  page.nextCursor!,
                ]);
              }}
            >
              Older imports
            </button>
          </div>
          <ol>
            {rows.map((h) => (
              <li key={h.id}>
                <strong>{h.title}</strong>
                <p>
                  {xpTime(h.importedAt)} · {h.actorName} · {h.outcome}
                </p>
                <p>
                  Receipt {h.id} · WOM #{h.competitionId}
                </p>
                <p>
                  {h.changes
                    .map(
                      (c) =>
                        skillName(c.skill) +
                        ' ' +
                        exactXp(c.before) +
                        ' → ' +
                        exactXp(c.after) +
                        ' (' +
                        signedXp(c.change) +
                        ' XP)',
                    )
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

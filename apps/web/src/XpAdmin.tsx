/** XP history remains private; all new imports share the lifecycle-aware competition flow. */
import { useEffect, useState } from 'react';
import { CompetitionImport } from './CompetitionImport.tsx';
import { classifyAccessFailure } from './admin-session.ts';
import type { CompetitionClient } from './competition-api.ts';
import {
  signedXp,
  skillName,
  type AdminSession,
  type ImportEntry,
  type XpClient,
} from './xp-model.ts';
import { xpTime } from './XpTables.tsx';
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
  const [error, setError] = useState<string>(),
    [history, setHistory] = useState<ImportEntry[]>([]),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    // Never carry private history across accounts, refresh failures or access
    // loss. The shell already verified the session; XP must not check it again.
    setHistory([]);
    setError(undefined);
    if (session.role === 'admin')
      void client
        .history(controller.signal)
        .then((rows) => {
          if (active && !controller.signal.aborted) {
            setHistory(rows);
            setError(undefined);
          }
        })
        .catch((failure: unknown) => {
          if (!active || controller.signal.aborted) return;
          setHistory([]);
          if (classifyAccessFailure(failure) === 'expired')
            onAccessLost();
          else
            setError(
              classifyAccessFailure(failure) === 'denied'
                ? 'Your account is not allowed to view XP import history.'
                : 'XP import history could not be loaded. Retry to refresh.',
            );
        })
        .finally(() => clearTimeout(timer));
    else clearTimeout(timer);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, session, refresh, onAccessLost]);
  return (
    <section className="xp-panel">
      <h2>{previewMode ? 'Preview XP imports' : 'XP competition imports'}</h2>
      {error && <p role="alert">{error}</p>}
      <>
          <CompetitionImport
            client={competitionClient}
            session={session}
            onAccessLost={onAccessLost}
            onApplied={() => {
              setRefresh((n) => n + 1);
              onApplied();
            }}
          />
          {session.role === 'admin' && (
            <details className="xp-history">
              <summary>Import history ({history.length})</summary>
              {!history.length && <p>No imports recorded yet.</p>}
              <ol>
                {history.map((h) => (
                  <li key={h.id}>
                    <strong>{h.title}</strong>
                    <p>
                      {xpTime(h.importedAt)} · {h.actorName} · {h.outcome}
                    </p>
                    <p>
                      {h.changes
                        .map(
                          (c) =>
                            skillName(c.skill) +
                            ' ' +
                            signedXp(c.change) +
                            ' XP',
                        )
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
    </section>
  );
}

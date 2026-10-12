/** XP history remains private; all new imports share the lifecycle-aware competition flow. */
import { useEffect, useState } from 'react';
import { CompetitionImport } from './CompetitionImport.tsx';
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
}: {
  client: XpClient;
  competitionClient: CompetitionClient;
  onApplied: () => void;
  previewMode: boolean;
}) {
  const [session, setSession] = useState<AdminSession | null>(),
    [error, setError] = useState<string>(),
    [history, setHistory] = useState<ImportEntry[]>([]),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    void client
      .session(controller.signal)
      .then(async (s) => {
        if (!active) return;
        setSession(s);
        if (s?.role === 'admin') {
          const h = await client.history(controller.signal);
          if (active) setHistory(h);
        }
      })
      .catch(() => {
        if (active)
          setError('Admin access or import history could not be loaded.');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, refresh]);
  return (
    <section className="xp-panel">
      <h2>{previewMode ? 'Preview XP imports' : 'XP competition imports'}</h2>
      {error && <p role="alert">{error}</p>}
      {session === undefined ? (
        <p role="status">Checking admin access…</p>
      ) : session === null ? (
        <p>Sign in with your staff account to import competitions.</p>
      ) : (
        <>
          <CompetitionImport
            client={competitionClient}
            session={session}
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
      )}
    </section>
  );
}

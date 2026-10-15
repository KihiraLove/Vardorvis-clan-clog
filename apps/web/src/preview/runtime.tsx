/** Opt-in production demo: isolated, resettable sample clients; never live staff access. */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { PreviewAdminClient } from './admin.ts';
import { PreviewXpClient } from './xp.ts';
import { PreviewCompetitionClient } from './competition.ts';
import { scenarios, type Scenario } from './scenarios.ts';
import { CollectionLog } from '../CollectionLog.tsx';
import { ActivityCompetitions } from '../ActivityCompetitions.tsx';
import type { CompetitionClient } from '../competition-api.ts';
import type { SiteCopy } from '@clog/domain';
import type { AppRuntime } from '../app-runtime.ts';
function PreviewLog({
  client,
  hardcore,
  copy,
  competitionClient,
}: {
  client: PreviewAdminClient;
  hardcore: boolean;
  copy: SiteCopy;
  competitionClient: CompetitionClient;
}) {
  const [scenario, setScenario] = useState<Scenario | 'reviewed'>('reviewed');
  const revision = useSyncExternalStore(client.subscribe, client.getRevision);
  const data = useMemo(
    () => client.publicLog(scenario),
    [client, revision, scenario],
  );
  return (
    <>
      <details className="preview-options">
        <summary>Frontend preview · sample data</summary>
        <label>
          Review scenario{' '}
          <select
            value={scenario}
            onChange={(event) =>
              setScenario(event.target.value as Scenario | 'reviewed')
            }
          >
            <option value="reviewed">Admin review results</option>
            {scenarios.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          Review fixtures only. Reload resets changes; no clan data is changed.
        </p>
      </details>
      <CollectionLog
        preview
        data={data}
        hardcore={hardcore}
        copy={copy}
        activity={<ActivityCompetitions client={competitionClient} />}
      />
    </>
  );
}

export function createPreviewRuntime(): AppRuntime {
  const admin = new PreviewAdminClient();
  const xp = new PreviewXpClient((signal) => admin.session(signal));
  const competition = new PreviewCompetitionClient(admin, xp, (value) =>
    xp.storeMetadata(value),
  );
  return {
    admin,
    xp,
    competition,
    dispose: () => admin.dispose(),
    preview: {
      subscribe: admin.subscribe,
      getRevision: admin.getRevision,
      settings: () => admin.publicSettings(),
      branding: (hardcore) => admin.publicBranding(hardcore),
      Log: (props) => (
        <PreviewLog {...props} client={admin} competitionClient={competition} />
      ),
      xpControls: { samples: () => xp.samples(), advance: () => xp.advance() },
    },
  };
}

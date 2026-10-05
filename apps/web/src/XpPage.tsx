import { useState } from 'react';
import { useXp } from './use-xp.ts';
import { XpAmount } from './XpAmount.tsx';
import { XpAdmin } from './XpAdmin.tsx';
import { MemberTable, ParticipantTable, xpDate, xpTime } from './XpTables.tsx';
import { skills, skillName, type SkillId, type XpClient } from './xp-model.ts';
import { PreviewXpClient } from './preview/xp.ts';

export function XpPage({
  client,
  admin,
  preview,
  onMode,
  onNavigate,
}: {
  client: XpClient;
  admin: boolean;
  preview: boolean;
  onMode: (next: boolean) => void;
  onNavigate: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const requested = new URLSearchParams(window.location.search).get('skill');
  const [selected, setSelected] = useState<SkillId>(
    skills.find(([id]) => id === requested)?.[0] ?? 'attack',
  );
  const [competitionId, setCompetitionId] = useState<number>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [sampleError, setSampleError] = useState<string>();
  const { data, error, loading, retry } = useXp(
    client,
    selected,
    competitionId,
    refreshKey,
  );
  const refresh = () => setRefreshKey((key) => key + 1);
  const matching =
    data?.overview.competitions.filter((c) => c.skills.includes(selected)) ??
    [];
  const detailReady =
    data?.skill === selected &&
    (competitionId === undefined ||
      data.detail?.competition.id === competitionId ||
      !matching.some((c) => c.id === competitionId));
  const choose = (id: SkillId) => {
    setSelected(id);
    setCompetitionId(undefined);
  };
  const sampleClient = client instanceof PreviewXpClient ? client : undefined;
  const total = data
    ? Object.values(data.overview.totals)
        .reduce((sum, value) => sum + BigInt(value), 0n)
        .toString()
    : null;
  return (
    <div className="xp-page">
      {preview && (
        <div className="preview-banner">
          <div>
            <strong>Frontend preview</strong>
            <p>
              Sample XP only. Imports and refreshes here never change the live
              clan tracker.
            </p>
          </div>
          <button
            type="button"
            className="site-button"
            onClick={() => onMode(false)}
          >
            View live XP
          </button>
        </div>
      )}
      <div className="xp-page-heading">
        <div>
          <p className="xp-eyebrow">Vardorvis clan · Competition gains</p>
          <h1>XP gained</h1>
          <p>
            Every skill. Every competitor. All the experience we earn together.
          </p>
        </div>
        <button
          type="button"
          className="site-button"
          onClick={retry}
          disabled={loading}
        >
          Refresh XP
        </button>
      </div>
      {sampleClient && (
        <div className="preview-controls">
          <button
            type="button"
            className="site-button"
            onClick={() => {
              void sampleClient
                .samples()
                .then(refresh)
                .catch((failure: unknown) => setSampleError(String(failure)));
            }}
          >
            Show sample XP
          </button>
          <button
            type="button"
            className="site-button"
            onClick={() => {
              sampleClient.advance();
              setSampleError(undefined);
            }}
          >
            Advance sample Attack results
          </button>
          <span>Import sample 1001 again to add its new gains.</span>
          {sampleError && <p role="alert">{sampleError}</p>}
        </div>
      )}
      {admin && (
        <XpAdmin client={client} onApplied={refresh} previewMode={preview} />
      )}
      {error && (
        <div className="xp-status xp-error" role="alert">
          <strong>
            {data ? 'XP refresh failed' : 'XP tracker unavailable'}
          </strong>
          <p>
            {error} {data && 'Showing the last successful update.'}
          </p>
          <button type="button" className="site-button" onClick={retry}>
            Retry XP
          </button>
          {!preview && (
            <button
              type="button"
              className="site-button"
              onClick={() => onMode(true)}
            >
              View XP preview
            </button>
          )}
        </div>
      )}
      {loading && (
        <p className="xp-status" role="status">
          {data ? 'Refreshing recorded XP…' : 'Loading clan XP…'}
        </p>
      )}
      <div className="xp-layout">
        <section className="skill-panel" aria-label="Clan skill XP">
          <div className="skill-panel__title">Clan skills</div>
          <div className="skill-grid" role="group" aria-label="Select a skill">
            {skills.map(([id, name]) => (
              <XpAmount
                key={id}
                skill={id}
                label={name}
                xp={data?.overview.totals[id] ?? null}
                selected={selected === id}
                onSelect={() => choose(id)}
              />
            ))}
          </div>
          <div className="skill-panel__total">
            <span>Total XP gained</span>
            <XpAmount xp={total} label="All skills" />
          </div>
          <p className="skill-panel__hint">
            m = million XP · Hover or tap for exact XP
          </p>
        </section>
        <div className="xp-detail">
          <section className="xp-panel">
            <div className="xp-section-heading">
              <h2>{skillName(selected)}</h2>
              <XpAmount
                xp={data?.overview.totals[selected] ?? null}
                label={skillName(selected)}
              />
            </div>
            <p>Cumulative recorded XP across imported competitions.</p>
            {data && !data.overview.competitions.length && (
              <p className="xp-empty">
                No competitions imported yet. An admin can add a Wise Old Man
                competition to start tracking.
              </p>
            )}
            {data && detailReady ? (
              <MemberTable
                rows={data.members}
                skill={selected}
                key={selected}
              />
            ) : (
              <p className="xp-empty">
                {loading
                  ? 'Loading member results…'
                  : 'Member results are unavailable.'}
              </p>
            )}
          </section>
          {!!matching.length && (
            <section className="xp-panel">
              <label className="xp-competition-select">
                Competition results
                <select
                  value={
                    detailReady
                      ? data?.detail?.competition.id
                      : (competitionId ?? matching[0]?.id)
                  }
                  onChange={(event) =>
                    setCompetitionId(Number(event.target.value))
                  }
                >
                  {matching.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
              {data?.detail && detailReady ? (
                <>
                  <h3>{data.detail.competition.title}</h3>
                  <p className="xp-source">
                    {xpDate(data.detail.competition.startsAt)} –{' '}
                    {xpDate(data.detail.competition.endsAt)} ·{' '}
                    <a
                      href={data.detail.competition.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Wise Old Man
                    </a>
                  </p>
                  <ParticipantTable
                    detail={data.detail}
                    key={data.detail.competition.id}
                  />
                  <p className="xp-note">
                    Competition gains only. Zero XP is a tracked result;
                    unavailable means the source had no usable snapshot.
                  </p>
                  <p className="xp-freshness">
                    Imported {xpTime(data.detail.competition.importedAt)}
                  </p>
                </>
              ) : (
                <p role="status">Loading competition results…</p>
              )}
            </section>
          )}
        </div>
      </div>
      <div className="xp-bottom-note">
        <p>
          Totals add recorded skill gains from imported competitions.
          Overlapping competitions can count the same gameplay more than once.
        </p>
        {data?.overview.updatedAt && (
          <p>Last successful update: {xpTime(data.overview.updatedAt)}</p>
        )}
        {!admin && (
          <a
            href={'/admin/xp' + (preview ? '?preview=1' : '')}
            onClick={onNavigate}
          >
            Admin: import or refresh a competition
          </a>
        )}
      </div>
    </div>
  );
}

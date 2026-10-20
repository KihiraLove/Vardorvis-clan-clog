import type { PodiumPlayer } from './xp-tracker.ts';
import { formatCompetitionAmount } from '@clog/domain';
export function XpPodium({
  players,
  title,
  sourceUrl,
  unit = 'XP',
}: {
  players: PodiumPlayer[];
  title: string;
  sourceUrl?: string | undefined;
  unit?: string;
}) {
  return (
    <aside className="xp-podium" aria-label={'XP podium for ' + title}>
      <h2>Top players</h2>
      {!players.length ? (
        <p>No finished results yet.</p>
      ) : (
        <ol className="xp-podium__places">
          {players.map((p, i) => (
            <li
              className={'xp-podium__place xp-podium__place--' + (i + 1)}
              key={p.playerId}
            >
              <span
                className="xp-podium__name"
                title={formatCompetitionAmount(p.gained) + ' ' + unit}
              >
                {p.displayName}
              </span>
              <span className="xp-podium__step">
                <span className="sr-only">Place </span>
                {i + 1}
              </span>
            </li>
          ))}
        </ol>
      )}
      {sourceUrl && (
        <div className="event-source">
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            View event on Wise Old Man ↗
          </a>
        </div>
      )}
    </aside>
  );
}

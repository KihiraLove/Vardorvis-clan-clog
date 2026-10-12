import type { PodiumPlayer } from './xp-tracker.ts';
import { exactXp } from './xp-model.ts';
export function XpPodium({
  players,
  title,
}: {
  players: PodiumPlayer[];
  title: string;
}) {
  return (
    <aside className="xp-podium" aria-label={'XP podium for ' + title}>
      <h2>Top players</h2>
      <p>{title}</p>
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
                title={exactXp(p.gained) + ' XP'}
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
    </aside>
  );
}

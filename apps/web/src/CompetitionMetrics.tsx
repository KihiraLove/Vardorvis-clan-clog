import {
  competitionDefinitions,
  competitionMetricName,
  formatCompetitionAmount,
  type WomCompetition,
  type CompetitionStanding,
} from '@clog/domain';

export function CompetitionMetrics({
  competition,
}: {
  competition: WomCompetition;
}) {
  return (
    <p className="competition-metrics" aria-label="Competition metrics">
      Metrics:{' '}
      {competitionDefinitions(competition)
        .map(
          (d) =>
            competitionMetricName(d.metric) +
            (d.weight === '1' ? '' : ' × ' + formatCompetitionAmount(d.weight)),
        )
        .join(' · ')}
    </p>
  );
}
export function CompetitionBreakdown({
  players,
}: {
  players: CompetitionStanding[];
}) {
  if (!players.some((p) => p.deltas?.length)) return null;
  return (
    <details className="competition-breakdown">
      <summary>Metric breakdown</summary>
      <ul>
        {players.map((p) => (
          <li key={p.playerId}>
            {p.displayName}
            <ul>
              {p.deltas
                ?.filter((d) => d.metric !== 'total')
                .map((d) => (
                  <li key={d.metric}>
                    {competitionMetricName(d.metric)}:{' '}
                    {formatCompetitionAmount(d.gained)}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

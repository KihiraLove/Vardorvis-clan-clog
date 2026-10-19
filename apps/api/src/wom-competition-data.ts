/** Normalize official WOM metadata and finished scores without retaining raw responses. */
import {
  competitionScope,
  parseCompetitionDefinitions,
  parseCompetitionStandings,
  rankedCompetitionStandings,
  type WomCompetition,
  type CompetitionStanding,
} from '@clog/domain';
import { ApiError } from './types.js';

export const womObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const womInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);

export function womCompetitionMetadata(
  source: unknown,
  id: number,
): WomCompetition {
  if (
    !womObject(source) ||
    source.id !== id ||
    typeof source.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 200 ||
    !womInstant(source.startsAt) ||
    !womInstant(source.endsAt) ||
    Date.parse(source.endsAt) <= Date.parse(source.startsAt) ||
    !Array.isArray(source.metrics) ||
    !source.metrics.length
  )
    throw new ApiError(422, 'Incomplete WOM competition metadata.');
  const metrics = source.metrics.map((m: unknown) =>
    womObject(m) && typeof m.metric === 'string' ? m.metric : '',
  );
  try {
    const scope = competitionScope(metrics);
    return {
      id,
      kind: scope.kind,
      title: source.title.trim(),
      sourceUrl: 'https://wiseoldman.net/competitions/' + id,
      metrics,
      metricDefinitions: parseCompetitionDefinitions(source.metrics, metrics),
      startsAt: new Date(source.startsAt).toISOString(),
      endsAt: new Date(source.endsAt).toISOString(),
    };
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}

export function womCompetitionStandings(
  source: unknown,
  competition: WomCompetition,
): CompetitionStanding[] {
  if (
    !womObject(source) ||
    !womInstant(source.updatedAt) ||
    !Array.isArray(source.participations) ||
    source.participations.length > 10000 ||
    source.participantCount !== source.participations.length
  )
    throw new ApiError(422, 'Incomplete WOM participant roster.');
  try {
    const rows = source.participations.map((participant: unknown, index) => {
      if (
        !womObject(participant) ||
        !womObject(participant.player) ||
        !Array.isArray(participant.deltas)
      )
        throw new Error('Incomplete WOM participant results.');
      const deltas = participant.deltas.map((delta: unknown) => {
        if (!womObject(delta) || !womObject(delta.values))
          throw new Error('Unavailable WOM metric result.');
        return { metric: delta.metric, gained: delta.values.gained };
      });
      const scoreMetric =
        competition.metrics.length > 1 ? 'total' : competition.metrics[0];
      return {
        playerId: participant.playerId,
        displayName: participant.player.displayName,
        rank: index + 1,
        gained: deltas.find((d) => d.metric === scoreMetric)?.gained,
        deltas,
      };
    });
    // Validate every participant and metric before excluding zero-score entries.
    return rankedCompetitionStandings(
      parseCompetitionStandings(rows, competition.metrics),
    );
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}

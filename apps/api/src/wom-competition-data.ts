/** Normalize official WOM metadata and finished scores without retaining raw responses. */
import {
  competitionScope,
  parseCompetitionDefinitions,
  parseCompetitionStandings,
  rankedCompetitionStandings,
  womMetricType,
  competitionMetricType,
  type CustomCompetitionMetric,
  type CompetitionMetricDiscovery,
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

export class UnknownCompetitionMetrics extends ApiError {
  constructor(readonly discovery: CompetitionMetricDiscovery) {
    super(422, 'Unknown competition metrics need a saved definition.');
  }
}
export function womCompetitionDiscovery(
  source: unknown,
  id: number,
): CompetitionMetricDiscovery {
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
    !source.metrics.length ||
    source.metrics.length > 64
  )
    throw new ApiError(422, 'Incomplete WOM competition metadata.');
  const metrics = source.metrics.map((m: unknown) =>
    womObject(m) && typeof m.metric === 'string' ? m.metric : '',
  );
  if (
    metrics.some((metric) => !/^[a-z][a-z0-9_]{0,79}$/u.test(metric)) ||
    new Set(metrics).size !== metrics.length
  )
    throw new ApiError(422, 'Invalid or duplicate WOM metric scope.');
  try {
    return {
      id,
      title: source.title.trim(),
      sourceUrl: 'https://wiseoldman.net/competitions/' + id,
      // Upstream cannot supply our installation's custom type/XP/page definitions.
      metrics: parseCompetitionDefinitions(
        source.metrics.map((m) => {
          const row = m as Record<string, unknown>;
          return {
            metric: row.metric,
            weight: row.weight,
            createdAt: row.createdAt,
          };
        }),
        metrics,
      ),
      startsAt: new Date(source.startsAt).toISOString(),
      endsAt: new Date(source.endsAt).toISOString(),
      unknownMetrics: metrics.filter((metric) => !womMetricType(metric)),
    };
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}

export function womCompetitionMetadata(
  source: unknown,
  id: number,
  saved: readonly CustomCompetitionMetric[] = [],
): WomCompetition {
  const discovery = womCompetitionDiscovery(source, id);
  const definitions = discovery.metrics.map((d) => {
    const definition =
      !womMetricType(d.metric) && saved.find((m) => m.metric === d.metric);
    return { ...d, ...(definition ? { definition } : {}) };
  });
  const unknownMetrics = definitions
    .filter((d) => !competitionMetricType(d.metric, definitions))
    .map((d) => d.metric);
  // An unresolved metric cannot make an already incompatible known scope valid.
  const known = definitions.filter((d) =>
    competitionMetricType(d.metric, definitions),
  );
  if (known.length) {
    try {
      competitionScope(
        known.map((d) => d.metric),
        definitions,
      );
    } catch (error) {
      throw new ApiError(422, (error as Error).message);
    }
  }
  if (unknownMetrics.length)
    throw new UnknownCompetitionMetrics({ ...discovery, unknownMetrics });
  try {
    const scope = competitionScope(
      definitions.map((d) => d.metric),
      definitions,
    );
    return {
      id,
      kind: scope.kind,
      title: discovery.title,
      sourceUrl: discovery.sourceUrl,
      startsAt: discovery.startsAt,
      endsAt: discovery.endsAt,
      metrics: definitions.map((d) => d.metric),
      metricDefinitions: definitions,
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
      parseCompetitionStandings(
        rows,
        competition.metrics,
        competition.metricDefinitions,
      ),
    );
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
}

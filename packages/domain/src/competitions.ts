import { isSkill, skillIds, type Skill } from './skills.js';
import {
  competitionMetricType,
  type CompetitionMetric,
  type CompetitionStanding,
} from './competition-metrics.js';
export * from './competition-metrics.js';
/** Kind is derived from canonical WOM metadata, never from a caller's selection. */
export type CompetitionKind = 'SKILL' | 'ACTIVITY';
export interface CompetitionPreviewInput {
  competitionUrl: string;
  pageIds?: string[];
  /** Compatibility hint only; the server rejects any mismatch with WOM metadata. */
  kind?: CompetitionKind;
}
/** Classify scope independently of result availability or supported activity data. */
export function competitionScope(
  metrics: readonly string[],
  definitions: readonly CompetitionMetric[] = [],
): {
  kind: CompetitionKind;
  skills: Skill[];
} {
  if (
    !metrics.length ||
    metrics.some((metric) => !metric) ||
    new Set(metrics).size !== metrics.length
  )
    throw new Error('Invalid or duplicate WOM metric scope.');
  const types = new Set(
    metrics.map((metric) => competitionMetricType(metric, definitions)),
  );
  if (types.size === 1 && types.has('SKILL')) {
    if (metrics.includes('total') && metrics.length > 1)
      throw new Error('Mixed aggregate total scopes are unsupported.');
    const aggregate =
      metrics.includes('overall') ||
      (metrics.length === 1 && metrics[0] === 'total');
    const targets = metrics
      .filter(
        (metric) => metric !== 'overall' && !(aggregate && metric === 'total'),
      )
      .map(
        (metric) =>
          definitions.find((d) => d.metric === metric)?.definition?.skill ??
          metric,
      );
    if (
      targets.some((skill) => !isSkill(skill)) ||
      new Set(targets).size !== targets.length
    )
      throw new Error(
        'Custom XP metrics use unsupported or duplicate skill targets.',
      );
    return {
      kind: 'SKILL',
      skills: aggregate
        ? [...skillIds]
        : skillIds.filter((skill) => targets.includes(skill)),
    };
  }
  if (types.has(undefined))
    throw new Error('Unknown WOM metrics are unsupported.');
  if (types.size !== 1 || types.has('SKILL'))
    throw new Error('Mixed metric types are unsupported by WOM.');
  return { kind: 'ACTIVITY', skills: [] };
}
export type CompetitionLifecycle = 'future' | 'running' | 'finished';
export type CompetitionImportAction =
  | 'import-metadata'
  | 'create-schedule'
  | 'update-schedule'
  | 'preserve-deletion'
  | 'import-results';
export function competitionImportAction(
  kind: CompetitionKind,
  lifecycle: CompetitionLifecycle,
  scheduleCreated = false,
  scheduleExists = false,
  opensPages = kind === 'ACTIVITY',
): CompetitionImportAction {
  if (lifecycle === 'finished') return 'import-results';
  if (!opensPages) return 'import-metadata';
  return scheduleCreated
    ? scheduleExists
      ? 'update-schedule'
      : 'preserve-deletion'
    : 'create-schedule';
}
export interface WomCompetition {
  id: number;
  kind: CompetitionKind;
  title: string;
  sourceUrl: string;
  metrics: string[];
  metricDefinitions?: CompetitionMetric[];
  /** Finished public results contain only the top three; import snapshots retain all. */
  standings?: CompetitionStanding[];
  startsAt: string;
  endsAt: string;
}
export function competitionLifecycle(
  competition: Pick<WomCompetition, 'startsAt' | 'endsAt'>,
  now: number,
): CompetitionLifecycle {
  return now < Date.parse(competition.startsAt)
    ? 'future'
    : now < Date.parse(competition.endsAt)
      ? 'running'
      : 'finished';
}

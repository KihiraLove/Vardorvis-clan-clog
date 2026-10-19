import { isSkill, skillIds, type Skill } from './skills.js';
import {
  womMetricType,
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
export function competitionScope(metrics: readonly string[]): {
  kind: CompetitionKind;
  skills: Skill[];
} {
  if (
    !metrics.length ||
    metrics.some((metric) => !metric) ||
    new Set(metrics).size !== metrics.length
  )
    throw new Error('Invalid or duplicate WOM metric scope.');
  const aggregate = (metric: string) =>
    metric === 'overall' || metric === 'total';
  if (
    (metrics.every((metric) => isSkill(metric) || metric === 'overall') &&
      metrics.includes('overall')) ||
    (metrics.length === 1 && aggregate(metrics[0]!))
  )
    return { kind: 'SKILL', skills: [...skillIds] };
  if (metrics.every(isSkill))
    return {
      kind: 'SKILL',
      skills: skillIds.filter((skill) => metrics.includes(skill)),
    };
  const types = new Set(metrics.map(womMetricType));
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
  | 'preserve-schedule'
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
      ? 'preserve-schedule'
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

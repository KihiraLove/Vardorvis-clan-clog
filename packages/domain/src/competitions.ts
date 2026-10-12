/** Staff chooses the application kind; WOM metrics never choose it implicitly. */
export type CompetitionKind = 'SKILL' | 'ACTIVITY';
export type CompetitionLifecycle = 'future' | 'running' | 'finished';
export interface WomCompetition {
  id: number;
  kind: CompetitionKind;
  title: string;
  sourceUrl: string;
  metrics: string[];
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

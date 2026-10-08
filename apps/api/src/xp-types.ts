/** XP aggregates and private preview data have no Discord-auth or browser dependencies. */
export const skillIds = [
  'attack',
  'hitpoints',
  'mining',
  'strength',
  'agility',
  'smithing',
  'defence',
  'herblore',
  'fishing',
  'ranged',
  'thieving',
  'cooking',
  'prayer',
  'crafting',
  'firemaking',
  'magic',
  'fletching',
  'woodcutting',
  'runecrafting',
  'slayer',
  'farming',
  'construction',
  'hunter',
  'sailing',
] as const;
export type Skill = (typeof skillIds)[number];
export type Gains = Partial<Record<Skill, string>>;
export interface XpParticipant {
  playerId: number;
  displayName: string;
  gains: Gains;
}
export interface XpEvent {
  id: number;
  title: string;
  sourceUrl: string;
  skills: Skill[];
  gains: Gains;
}
export interface XpSnapshot {
  event: XpEvent;
  participants: XpParticipant[];
  startsAt: string;
  endsAt: string;
  sourceUpdatedAt: string;
  sourceHash: string;
}
export interface XpChange {
  skill: Skill;
  before: string;
  after: string;
  change: string;
}
export interface XpPreview {
  previewToken: string;
  expectedRevision: string;
  expiresAt: string;
  competition: {
    id: number;
    title: string;
    sourceUrl: string;
    skills: Skill[];
    startsAt: string;
    endsAt: string;
    importedAt: string;
  };
  participants: XpParticipant[];
  changes: XpChange[];
  warnings: string[];
}
export interface XpApply {
  outcome: 'applied' | 'unchanged';
  revision: string;
}
export interface XpStore {
  tracker(): Promise<{
    revision: string;
    totals: Record<Skill, string>;
    events: XpEvent[];
  }>;
  preview(snapshot: XpSnapshot, actor: string): Promise<XpPreview>;
  apply(
    token: string,
    revision: string,
    key: string,
    actor: string,
    actorName: string,
    acknowledgeCorrections: boolean,
  ): Promise<XpApply>;
  history(): Promise<{
    imports: {
      id: string;
      competitionId: number;
      title: string;
      actorName: string;
      importedAt: string;
      outcome: 'applied' | 'unchanged';
      changes: XpChange[];
    }[];
  }>;
}
export const emptyTotals = (): Record<Skill, string> =>
  Object.fromEntries(skillIds.map((id) => [id, '0'])) as Record<Skill, string>;
export const revisionFor = (version: string | number): string =>
  'xp-' + version;
export function sumTotals(events: XpEvent[]): Record<Skill, string> {
  const totals = emptyTotals();
  for (const event of events)
    for (const id of event.skills)
      totals[id] = (BigInt(totals[id]) + BigInt(event.gains[id]!)).toString();
  return totals;
}
export function diffTotals(
  before: Record<Skill, string>,
  prior: XpEvent | null,
  next: XpEvent,
): XpChange[] {
  const old = prior?.gains ?? {};
  return skillIds
    .map((skill) => {
      const current = BigInt(before[skill]);
      const delta =
        BigInt(next.gains[skill] ?? '0') - BigInt(old[skill] ?? '0');
      if (current + delta < 0n) throw new Error('Invalid XP reconciliation');
      return {
        skill,
        before: current.toString(),
        after: (current + delta).toString(),
        change: delta.toString(),
      };
    })
    .filter(
      (change) =>
        next.skills.includes(change.skill) ||
        (prior?.skills.includes(change.skill) ?? false),
    );
}

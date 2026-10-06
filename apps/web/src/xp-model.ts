export const skills = [
  ['attack', 'Attack'],
  ['hitpoints', 'Hitpoints'],
  ['mining', 'Mining'],
  ['strength', 'Strength'],
  ['agility', 'Agility'],
  ['smithing', 'Smithing'],
  ['defence', 'Defence'],
  ['herblore', 'Herblore'],
  ['fishing', 'Fishing'],
  ['ranged', 'Ranged'],
  ['thieving', 'Thieving'],
  ['cooking', 'Cooking'],
  ['prayer', 'Prayer'],
  ['crafting', 'Crafting'],
  ['firemaking', 'Firemaking'],
  ['magic', 'Magic'],
  ['fletching', 'Fletching'],
  ['woodcutting', 'Woodcutting'],
  ['runecrafting', 'Runecraft'],
  ['slayer', 'Slayer'],
  ['farming', 'Farming'],
  ['construction', 'Construction'],
  ['hunter', 'Hunter'],
  ['sailing', 'Sailing'],
] as const;
export type SkillId = (typeof skills)[number][0];
export type Xp = string;
export type Gains = Partial<Record<SkillId, Xp | null>>;
export interface Competition {
  id: number;
  title: string;
  sourceUrl: string;
  skills: SkillId[];
  startsAt: string;
  endsAt: string;
  importedAt: string;
}
export interface Participant {
  playerId: number;
  displayName: string;
  gains: Gains;
}
export interface CompetitionDetail {
  competition: Competition;
  participants: Participant[];
}
export interface XpOverview {
  revision: string;
  updatedAt: string | null;
  totals: Record<SkillId, Xp>;
  competitions: Competition[];
}
export interface Member {
  playerId: number;
  displayName: string;
  xp: Xp | null;
}
export interface XpSnapshot {
  overview: XpOverview;
  skill: SkillId;
  members: Member[];
  detail?: CompetitionDetail | undefined;
}
export interface ImportChange {
  skill: SkillId;
  before: Xp;
  after: Xp;
  change: string;
}
export interface ImportPreview extends CompetitionDetail {
  previewToken: string;
  expectedRevision: string;
  expiresAt: string;
  changes: ImportChange[];
  warnings: string[];
}
export interface ImportEntry {
  id: string;
  competitionId: number;
  title: string;
  actorName: string;
  importedAt: string;
  outcome: 'applied' | 'unchanged';
  changes: ImportChange[];
}
export interface AdminSession {
  csrfToken: string;
  displayName: string;
}
export interface ApplyResult {
  outcome: 'applied' | 'unchanged';
  revision: string;
}
export interface XpClient {
  load(
    skill: SkillId,
    competitionId: number | undefined,
    signal: AbortSignal,
  ): Promise<XpSnapshot>;
  session(signal: AbortSignal): Promise<AdminSession | null>;
  preview(
    url: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<ImportPreview>;
  apply(
    preview: ImportPreview,
    csrf: string,
    requestKey: string,
    signal: AbortSignal,
  ): Promise<ApplyResult>;
  history(signal: AbortSignal): Promise<ImportEntry[]>;
}
export const skillName = (id: SkillId) =>
  skills.find(([key]) => key === id)![1];
export const skillIcon = (id: SkillId) =>
  '/skills/' + (id === 'runecrafting' ? 'runecraft' : id) + '.png';
export const zeroTotals = () =>
  Object.fromEntries(skills.map(([id]) => [id, '0'])) as Record<SkillId, Xp>;
export const exactXp = (xp: Xp) =>
  new Intl.NumberFormat('en-GB').format(BigInt(xp));
export function millionXp(xp: Xp): string {
  const value = BigInt(xp);
  return (
    new Intl.NumberFormat('en-GB').format(value / 1_000_000n) +
    '.' +
    ((value % 1_000_000n) / 10_000n).toString().padStart(2, '0') +
    'm'
  );
}
export function signedXp(xp: string): string {
  return (BigInt(xp) > 0n ? '+' : '') + exactXp(xp);
}
export function compareXp(a: Xp | null, b: Xp | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0;
}
export function competitionUrl(input: string): { id: number; url: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a Wise Old Man competition link.');
  }
  const match = /^\/competitions\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    !['wiseoldman.net', 'www.wiseoldman.net'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !match ||
    !Number.isSafeInteger(Number(match[1]))
  )
    throw new Error('Use https://wiseoldman.net/competitions/<id>.');
  return {
    id: Number(match[1]),
    url: 'https://wiseoldman.net/competitions/' + match[1],
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid XP snapshot.');
  return value as Record<string, unknown>;
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing XP rows.');
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Missing XP text.');
  return value;
}
export function identity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Invalid XP identity.');
  return value;
}
export function amount(value: unknown, signed = false): string {
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !(signed ? /^(0|-?[1-9]\d*)$/u : /^(0|[1-9]\d*)$/u).test(value)
  )
    throw new Error('XP must be an exact decimal integer string.');
  return value;
}
export function timestamp(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(result) ||
    new Date(result.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !==
      result.slice(0, 10) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error('Invalid XP date.');
  return result;
}
export function skill(value: unknown): SkillId {
  if (!skills.some(([id]) => id === value))
    throw new Error('Unknown XP skill.');
  return value as SkillId;
}
export function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate XP identity.');
}
export function parseCompetition(value: unknown): Competition {
  const c = object(value);
  const source = competitionUrl(text(c.sourceUrl));
  const id = identity(c.id);
  if (source.id !== id) throw new Error('Competition link identity mismatch.');
  const ids = list(c.skills).map(skill);
  unique(ids);
  if (!ids.length) throw new Error('Competition has no skill XP.');
  const startsAt = timestamp(c.startsAt),
    endsAt = timestamp(c.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt))
    throw new Error('Invalid competition period.');
  return {
    id,
    title: text(c.title),
    sourceUrl: source.url,
    skills: ids,
    startsAt,
    endsAt,
    importedAt: timestamp(c.importedAt),
  };
}
export function parseParticipants(
  value: unknown,
  ids: SkillId[],
): Participant[] {
  const rows = list(value).map((entry) => {
    const p = object(entry),
      gains = object(p.gains);
    if (Object.keys(gains).some((key) => !ids.includes(skill(key))))
      throw new Error('Unexpected competition metric.');
    return {
      playerId: identity(p.playerId),
      displayName: text(p.displayName),
      gains: Object.fromEntries(
        ids.map((id) => [id, gains[id] === null ? null : amount(gains[id])]),
      ) as Gains,
    };
  });
  unique(rows.map((p) => p.playerId));
  return rows;
}
export function parseChanges(value: unknown): ImportChange[] {
  const changes = list(value).map((entry) => {
    const c = object(entry),
      before = amount(c.before),
      after = amount(c.after),
      change = amount(c.change, true);
    if (BigInt(after) - BigInt(before) !== BigInt(change))
      throw new Error('Inconsistent XP change.');
    return { skill: skill(c.skill), before, after, change };
  });
  unique(changes.map((c) => c.skill));
  return changes;
}
export function parsePreview(value: unknown): ImportPreview {
  const p = object(value),
    competition = parseCompetition(p.competition);
  const changes = parseChanges(p.changes);
  if (
    changes.length !== competition.skills.length ||
    changes.some((c) => !competition.skills.includes(c.skill))
  )
    throw new Error('Incomplete import changes.');
  return {
    competition,
    participants: parseParticipants(p.participants, competition.skills),
    previewToken: text(p.previewToken),
    expectedRevision: text(p.expectedRevision),
    expiresAt: timestamp(p.expiresAt),
    changes,
    warnings: list(p.warnings).map(text),
  };
}

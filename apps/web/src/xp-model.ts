/** XP wire types, exact arithmetic and parsers; also supplies shared private-response guards. */
import {
  skills,
  isSkill,
  parseStaffPages,
  type StaffPage,
  type Skill,
} from '@clog/domain';
export { skills, skillName, skillIcon } from '@clog/domain';
export type SkillId = Skill;
// Decimal strings survive JSON without Number rounding; null means unavailable, not zero.
export type Xp = string;
export type Gains = Partial<Record<SkillId, Xp | null>>;
export interface ImportChange {
  skill: SkillId;
  before: Xp;
  after: Xp;
  change: string;
}
export interface AdminSession {
  allowedPages?: StaffPage[];
  csrfToken: string;
  displayName: string;
  username: string;
  role: 'admin' | 'moderator';
  mustChangePassword: boolean;
}
export function parseAdminSession(input: unknown): AdminSession | null {
  const value = object(input);
  if (value.authenticated === false) return null;
  if (
    value.authenticated !== true ||
    !['admin', 'moderator'].includes(String(value.role)) ||
    typeof value.mustChangePassword !== 'boolean'
  )
    throw new Error('Invalid admin session.');
  return {
    csrfToken: text(value.csrfToken),
    displayName: text(value.displayName),
    username: text(value.username),
    role: value.role as AdminSession['role'],
    mustChangePassword: value.mustChangePassword,
    ...(value.allowedPages === undefined
      ? {}
      : { allowedPages: parseStaffPages(value.allowedPages) }),
  };
}
export interface XpClient {
  tracker(signal: AbortSignal): Promise<import('./xp-tracker.ts').XpTracker>;
  session(signal: AbortSignal): Promise<AdminSession | null>;
}
export const zeroTotals = () =>
  Object.fromEntries(skills.map(([id]) => [id, '0'])) as Record<SkillId, Xp>;
export const exactXp = (xp: Xp) =>
  new Intl.NumberFormat('en-GB').format(BigInt(xp));
/** Truncate to two million-unit decimals so abbreviated labels never overstate gains. */
export function millionXp(xp: Xp): string {
  const value = BigInt(xp);
  return (
    (value / 1_000_000n).toString() +
    '.' +
    ((value % 1_000_000n) / 10_000n).toString().padStart(2, '0') +
    'm'
  );
}
export function signedXp(xp: string): string {
  return (BigInt(xp) > 0n ? '+' : '') + exactXp(xp);
}
/** Sort largest exact gains first, retaining unavailable rows at the end. */
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
/** Accept canonical integer strings; only change deltas may be negative. */
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
  if (!isSkill(value)) throw new Error('Unknown XP skill.');
  return value as SkillId;
}
export function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length)
    throw new Error('Duplicate XP identity.');
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

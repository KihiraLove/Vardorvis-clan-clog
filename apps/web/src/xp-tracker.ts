/** Public events need only identity/link, name, skill scope and aggregate gained XP. */
import {
  amount,
  competitionUrl,
  identity,
  list,
  object,
  skill,
  skills,
  text,
  unique,
  zeroTotals,
  type SkillId,
  type Xp,
} from './xp-model.ts';
export interface XpEvent {
  id: number;
  title: string;
  sourceUrl: string;
  skills: SkillId[];
  gains: Partial<Record<SkillId, Xp | null>>;
}
export interface XpTracker {
  revision: string;
  totals: Record<SkillId, Xp>;
  events: XpEvent[];
}
export function parseTracker(value: unknown): XpTracker {
  const data = object(value),
    totals = object(data.totals);
  const result = zeroTotals();
  if (Object.keys(totals).length !== skills.length)
    throw new Error('Incomplete skill totals.');
  for (const [id] of skills) result[id] = amount(totals[id]);
  const events = list(data.events).map((entry) => {
    const row = object(entry),
      id = identity(row.id),
      source = competitionUrl(text(row.sourceUrl));
    if (source.id !== id) throw new Error('Event identity mismatch.');
    const ids = list(row.skills).map(skill);
    unique(ids);
    if (ids.length !== 1 && ids.length !== skills.length)
      throw new Error('An event must track one skill or all skills.');
    const gains = object(row.gains);
    if (
      Object.keys(gains).length !== ids.length ||
      Object.keys(gains).some((key) => !ids.includes(skill(key)))
    )
      throw new Error('Unexpected event skills.');
    return {
      id,
      title: text(row.title),
      sourceUrl: source.url,
      skills: ids,
      gains: Object.fromEntries(
        ids.map((id) => [id, gains[id] === null ? null : amount(gains[id])]),
      ),
    };
  });
  unique(events.map((event) => event.id));
  return { revision: text(data.revision), totals: result, events };
}
export function eventTotals(event: XpEvent): Record<SkillId, Xp | null> {
  return { ...zeroTotals(), ...event.gains };
}
export function sumXp(totals: Record<SkillId, Xp | null>): Xp | null {
  const values = Object.values(totals);
  // Do not present an incomplete event as a complete exact total.
  return values.some((value) => value === null)
    ? null
    : String(values.reduce<bigint>((sum, value) => sum + BigInt(value!), 0n));
}

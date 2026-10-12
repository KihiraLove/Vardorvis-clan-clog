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
  podium?: PodiumPlayer[];
}
export interface PodiumPlayer {
  playerId: number;
  displayName: string;
  gained: string;
}
export function podiumFromParticipants(
  players: {
    playerId: number;
    displayName: string;
    gains: Partial<Record<SkillId, string | null>>;
  }[],
): PodiumPlayer[] {
  const sums = new Map<number, PodiumPlayer>();
  for (const p of players) {
    const values = Object.values(p.gains);
    if (values.some((n) => n === null || n === undefined)) continue;
    const gained = values.reduce((sum, n) => sum + BigInt(n!), 0n);
    if (gained <= 0n) continue;
    sums.set(p.playerId, {
      playerId: p.playerId,
      displayName: p.displayName,
      gained: (BigInt(sums.get(p.playerId)?.gained ?? '0') + gained).toString(),
    });
  }
  return [...sums.values()]
    .sort((a, b) =>
      BigInt(a.gained) > BigInt(b.gained)
        ? -1
        : BigInt(a.gained) < BigInt(b.gained)
          ? 1
          : a.playerId - b.playerId,
    )
    .slice(0, 3);
}
export interface XpTracker {
  revision: string;
  totals: Record<SkillId, Xp>;
  events: XpEvent[];
  podium?: PodiumPlayer[];
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
    if (!ids.length) throw new Error('An event needs supported skills.');
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
      ...(row.podium === undefined ? {} : { podium: parsePodium(row.podium) }),
    };
  });
  unique(events.map((event) => event.id));
  return {
    revision: text(data.revision),
    totals: result,
    events,
    ...(data.podium === undefined ? {} : { podium: parsePodium(data.podium) }),
  };
}
export function parsePodium(value: unknown): PodiumPlayer[] {
  const players = list(value).map((r) => {
    const p = object(r);
    const gained = amount(p.gained);
    if (BigInt(gained) <= 0n)
      throw new Error('Podium requires positive gains.');
    return {
      playerId: identity(p.playerId),
      displayName: text(p.displayName),
      gained,
    };
  });
  unique(players.map((p) => p.playerId));
  if (
    players.length > 3 ||
    players.some(
      (p, i) =>
        i > 0 &&
        (BigInt(players[i - 1]!.gained) < BigInt(p.gained) ||
          (players[i - 1]!.gained === p.gained &&
            players[i - 1]!.playerId > p.playerId)),
    )
  )
    throw new Error('Invalid podium ranking.');
  return players;
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

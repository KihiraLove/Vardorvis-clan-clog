/** Fetch only the fixed official WOM API and reject incomplete, unsafe source rows. */
import { createHash } from 'node:crypto';
import { ApiError } from './types.js';
import {
  skillIds,
  type Gains,
  type Skill,
  type XpParticipant,
  type XpSnapshot,
} from './xp-types.js';

const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const date = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString().slice(0, 10) === x.slice(0, 10);
const decimal = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  // Decimals over JS's safe number limit must be sent as strings; never round them.
  if (typeof value === 'string' && /^(0|[1-9]\d{0,99})$/u.test(value))
    return value;
  throw new ApiError(
    422,
    'WOM contains missing or non-integer gained XP; import was not changed.',
  );
};
export function parseCompetitionUrl(input: string): {
  id: number;
  url: string;
} {
  let uri: URL;
  try {
    uri = new URL(input.trim());
  } catch {
    throw new ApiError(400, 'Enter a WOM competition link.');
  }
  const match = /^\/competitions\/([1-9]\d*)\/?$/u.exec(uri.pathname);
  const id = Number(match?.[1]);
  if (
    uri.protocol !== 'https:' ||
    !['wiseoldman.net', 'www.wiseoldman.net'].includes(uri.hostname) ||
    uri.username ||
    uri.password ||
    uri.port ||
    !match ||
    !Number.isSafeInteger(id) ||
    id <= 0
  )
    throw new ApiError(400, 'Use https://wiseoldman.net/competitions/<id>.');
  return { id, url: 'https://wiseoldman.net/competitions/' + id };
}
function metricNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length)
    throw new ApiError(422, 'WOM competition has no metric scope.');
  const names = value.map((v: unknown) =>
    record(v) && typeof v.metric === 'string' ? v.metric : null,
  );
  if (names.some((x) => x === null) || new Set(names).size !== names.length)
    throw new ApiError(
      422,
      'WOM returned invalid or duplicate competition metrics.',
    );
  return names as string[];
}
function strictScope(names: string[]): Skill[] {
  if (names.length === 1 && skillIds.some((s) => s === names[0]))
    return [names[0] as Skill];
  if (names.length === 1 && ['overall', 'total'].includes(names[0]!))
    return [...skillIds];
  if (
    names.length === skillIds.length &&
    skillIds.every((skill) => names.includes(skill))
  )
    return [...skillIds];
  throw new ApiError(
    422,
    'WOM competition must track one skill or all supported skills.',
  );
}
function metadata(source: unknown, requestedId: number) {
  if (
    !record(source) ||
    source.id !== requestedId ||
    typeof source.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 200 ||
    !date(source.startsAt) ||
    !date(source.endsAt) ||
    Date.parse(source.endsAt) <= Date.parse(source.startsAt) ||
    !date(source.updatedAt) ||
    !Array.isArray(source.participations) ||
    source.participations.length > 10000 ||
    (source.participantCount !== undefined &&
      source.participantCount !== source.participations.length)
  )
    throw new ApiError(
      422,
      'Incomplete WOM competition metadata or participants.',
    );
  return source as {
    id: number;
    title: string;
    startsAt: string;
    endsAt: string;
    updatedAt: string;
    metrics: unknown;
    participations: unknown[];
    participantCount: number;
  };
}
export function parseWomSnapshot(
  original: unknown,
  breakdown: unknown | undefined,
  expectedId: number,
): XpSnapshot {
  const source = metadata(original, expectedId);
  const scope = strictScope(metricNames(source.metrics));
  const details = scope.length === 1 ? source : metadata(breakdown, expectedId);
  if (
    details.id !== source.id ||
    details.title !== source.title ||
    details.startsAt !== source.startsAt ||
    details.endsAt !== source.endsAt ||
    details.participations.length !== source.participations.length
  )
    throw new ApiError(
      422,
      'WOM per-skill breakdown does not match the source competition.',
    );
  const seen = new Set<number>();
  const participants: XpParticipant[] = [];
  const sourceIds = new Set<number>();
  for (const p of source.participations) {
    if (!record(p) || !positive(p.playerId))
      throw new ApiError(422, 'Invalid WOM player identity.');
    if (sourceIds.has(p.playerId))
      throw new ApiError(422, 'Duplicate WOM participants.');
    sourceIds.add(p.playerId);
  }
  for (const p of details.participations) {
    if (
      !record(p) ||
      !positive(p.playerId) ||
      !record(p.player) ||
      typeof p.player.displayName !== 'string' ||
      !p.player.displayName.trim() ||
      !Array.isArray(p.deltas) ||
      p.deltas.length > skillIds.length + 1 ||
      seen.has(p.playerId) ||
      !sourceIds.has(p.playerId)
    )
      throw new ApiError(422, 'Incomplete or duplicate WOM participant.');
    seen.add(p.playerId);
    const gains: Gains = {};
    const metrics = new Set<string>();
    for (const d of p.deltas) {
      if (
        !record(d) ||
        typeof d.metric !== 'string' ||
        !record(d.values) ||
        metrics.has(d.metric) ||
        (d.metric !== 'total' && !scope.includes(d.metric as Skill))
      )
        throw new ApiError(422, 'Unexpected WOM delta metric.');
      metrics.add(d.metric);
      if (d.metric !== 'total')
        gains[d.metric as Skill] = decimal(d.values.gained);
    }
    if (!scope.every((skill) => Object.hasOwn(gains, skill)))
      throw new ApiError(
        422,
        'WOM competition has unavailable skill XP; prior totals are preserved.',
      );
    participants.push({
      playerId: p.playerId,
      displayName: p.player.displayName.slice(0, 80),
      gains,
    });
  }
  if (seen.size !== sourceIds.size)
    throw new ApiError(422, 'WOM returned partial participant data.');
  participants.sort((a, b) => a.playerId - b.playerId);
  const gains: Gains = {};
  for (const skill of scope)
    gains[skill] = participants
      .reduce((sum, p) => sum + BigInt(p.gains[skill]!), 0n)
      .toString();
  const canonical = {
    id: expectedId,
    title: source.title.trim(),
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    updatedAt: source.updatedAt,
    skills: scope,
    participants,
  };
  const sourceHash = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return {
    event: {
      id: expectedId,
      title: source.title.trim(),
      sourceUrl: 'https://wiseoldman.net/competitions/' + expectedId,
      skills: scope,
      gains,
    },
    participants,
    startsAt: source.startsAt,
    endsAt: source.endsAt,
    sourceUpdatedAt: source.updatedAt,
    sourceHash,
  };
}
export async function fetchWomCompetition(
  input: string,
  request: typeof fetch = fetch,
): Promise<XpSnapshot> {
  const { id } = parseCompetitionUrl(input);
  const get = async (url: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(8500),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Vardorvis-clan-clog/1.0',
        },
      });
    } catch {
      throw new ApiError(
        503,
        'WOM is temporarily unavailable; no data was changed.',
      );
    }
    if (response.status === 429)
      throw new ApiError(429, 'WOM rate limit reached; no data was changed.');
    if (!response.ok)
      throw new ApiError(
        response.status === 404 ? 422 : 503,
        'WOM competition could not be fetched.',
      );
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ApiError(422, 'WOM returned invalid JSON.');
    }
  };
  const base = 'https://api.wiseoldman.net/v2/competitions/' + id;
  const original = await get(base);
  if (!record(original))
    throw new ApiError(422, 'WOM returned invalid competition details.');
  const scope = strictScope(metricNames(original.metrics));
  // WOM documents one request for a metric batch, not a request per player/skill.
  const query = new URLSearchParams();
  if (scope.length > 1)
    for (const skill of skillIds) query.append('metrics', skill);
  const breakdown =
    scope.length > 1 ? await get(base + '?' + query.toString()) : undefined;
  return parseWomSnapshot(original, breakdown, id);
}

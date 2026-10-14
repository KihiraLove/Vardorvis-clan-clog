import { createHash } from 'node:crypto';
import { competitionLifecycle, competitionScope } from '@clog/domain';
import { ApiError } from './types.js';
import { getWom, parseCompetitionUrl, parseWomSnapshot } from './wom.js';
import type { CompetitionSnapshot } from './competition-types.js';

// Official integer boss/activity metrics. Computed EHP/EHB and weighted mixed scopes are excluded.
export const activityMetrics = new Set(
  'bounty_hunter_hunter bounty_hunter_rogue clue_scrolls_all clue_scrolls_beginner clue_scrolls_easy clue_scrolls_medium clue_scrolls_hard clue_scrolls_elite clue_scrolls_master last_man_standing pvp_arena soul_wars_zeal guardians_of_the_rift colosseum_glory collections_logged abyssal_sire alchemical_hydra amoxliatl araxxor artio barrows_chests brutus bryophyta callisto calvarion cerberus chambers_of_xeric chambers_of_xeric_challenge_mode chaos_elemental chaos_fanatic commander_zilyana corporeal_beast crazy_archaeologist dagannoth_prime dagannoth_rex dagannoth_supreme deranged_archaeologist doom_of_mokhaiotl duke_sucellus general_graardor giant_mole grotesque_guardians hespori kalphite_queen king_black_dragon kraken kreearra kril_tsutsaroth lunar_chests mad_angel maggot_king mimic nex nightmare phosanis_nightmare obor phantom_muspah sarachnis scorpia scurrius shellbane_gryphon skotizo sol_heredit spindel tempoross the_gauntlet the_corrupted_gauntlet the_hueycoatl the_leviathan the_royal_titans the_whisperer theatre_of_blood theatre_of_blood_hard_mode thermonuclear_smoke_devil tombs_of_amascut tombs_of_amascut_expert tzkal_zuk tztok_jad vardorvis venenatis vetion vorkath wintertodt yama zalcano zulrah'.split(
    ' ',
  ),
);
const aliases: Record<string, string[]> = {
  artio: ['callisto_and_artio'],
  callisto: ['callisto_and_artio'],
  calvarion: ['vetion_and_calvarion'],
  vetion: ['vetion_and_calvarion'],
  spindel: ['venenatis_and_spindel'],
  venenatis: ['venenatis_and_spindel'],
  dagannoth_prime: ['dagannoth_kings'],
  dagannoth_rex: ['dagannoth_kings'],
  dagannoth_supreme: ['dagannoth_kings'],
  chambers_of_xeric_challenge_mode: ['chambers_of_xeric'],
  theatre_of_blood_hard_mode: ['theatre_of_blood'],
  tombs_of_amascut_expert: ['tombs_of_amascut'],
  kreearra: ['kree_arra'],
  lunar_chests: ['moons_of_peril'],
  mad_angel: ['the_mad_angel'],
  nightmare: ['the_nightmare'],
  phosanis_nightmare: ['the_nightmare'],
  the_corrupted_gauntlet: ['the_gauntlet'],
  the_hueycoatl: ['hueycoatl'],
  the_royal_titans: ['royal_titans'],
  tztok_jad: ['the_fight_caves'],
  tzkal_zuk: ['the_inferno'],
  sol_heredit: ['fortis_colosseum'],
  mimic: ['elite_treasure_trails', 'master_treasure_trails'],
  colosseum_glory: ['fortis_colosseum'],
  soul_wars_zeal: ['soul_wars'],
  clue_scrolls_beginner: [
    'beginner_treasure_trails',
    'shared_treasure_trail_rewards',
  ],
  clue_scrolls_easy: ['easy_treasure_trails', 'shared_treasure_trail_rewards'],
  clue_scrolls_medium: [
    'medium_treasure_trails',
    'shared_treasure_trail_rewards',
  ],
  clue_scrolls_hard: [
    'hard_treasure_trails',
    'hard_treasure_trails_rare',
    'shared_treasure_trail_rewards',
  ],
  clue_scrolls_elite: [
    'elite_treasure_trails',
    'elite_treasure_trails_rare',
    'shared_treasure_trail_rewards',
  ],
  clue_scrolls_master: [
    'master_treasure_trails',
    'master_treasure_trails_rare',
    'shared_treasure_trail_rewards',
  ],
  clue_scrolls_all: [
    'beginner_treasure_trails',
    'easy_treasure_trails',
    'medium_treasure_trails',
    'hard_treasure_trails',
    'elite_treasure_trails',
    'master_treasure_trails',
    'shared_treasure_trail_rewards',
    'hard_treasure_trails_rare',
    'elite_treasure_trails_rare',
    'master_treasure_trails_rare',
  ],
};
/** Explicit metric aliases plus reviewed identity mappings, validated against active catalog pages. */
export function mappedPages(metric: string): string[] {
  if (aliases[metric]) return aliases[metric]!;
  if (
    [
      'bounty_hunter_hunter',
      'bounty_hunter_rogue',
      'pvp_arena',
      'collections_logged',
    ].includes(metric)
  )
    return [];
  return activityMetrics.has(metric) ? [metric] : [];
}
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v.slice(0, 10);
export const competitionHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function fetchCompetition(
  input: string,
  now: number,
  request: typeof fetch = fetch,
  cancellation: AbortSignal = AbortSignal.timeout(6500),
): Promise<CompetitionSnapshot> {
  const { id, url } = parseCompetitionUrl(input);
  const base = 'https://api.wiseoldman.net/v2/competitions/' + id;
  const source = await getWom(base, request, cancellation);
  if (
    !obj(source) ||
    source.id !== id ||
    typeof source.title !== 'string' ||
    !source.title.trim() ||
    source.title.length > 200 ||
    !instant(source.startsAt) ||
    !instant(source.endsAt) ||
    Date.parse(source.endsAt) <= Date.parse(source.startsAt) ||
    !Array.isArray(source.metrics) ||
    !source.metrics.length
  )
    throw new ApiError(422, 'Incomplete WOM competition metadata.');
  const metrics = source.metrics.map((m: unknown) =>
    obj(m) && typeof m.metric === 'string' ? m.metric : '',
  );
  if (metrics.some((m) => !m) || new Set(metrics).size !== metrics.length)
    throw new ApiError(422, 'Invalid WOM metric scope.');
  let scope: ReturnType<typeof competitionScope>;
  try {
    scope = competitionScope(metrics);
  } catch (error) {
    throw new ApiError(422, (error as Error).message);
  }
  const { kind, skills } = scope;
  if (
    kind === 'ACTIVITY' &&
    (metrics.length !== 1 || !activityMetrics.has(metrics[0]!))
  )
    throw new ApiError(
      422,
      'Unsupported WOM activity scope. Computed metrics and unknown boss/activity metrics cannot be imported.',
    );
  if (
    source.metrics.some(
      (m: unknown) =>
        obj(m) &&
        m.weight !== undefined &&
        (typeof m.weight !== 'number' ||
          !Number.isFinite(m.weight) ||
          m.weight <= 0 ||
          (kind === 'ACTIVITY' && m.weight !== 1)),
    )
  )
    throw new ApiError(
      422,
      'Unsupported WOM metric weights. Activity results require an unweighted integer metric.',
    );
  const competition = {
    id,
    kind,
    title: source.title.trim(),
    sourceUrl: url,
    metrics,
    startsAt: new Date(source.startsAt).toISOString(),
    endsAt: new Date(source.endsAt).toISOString(),
  };
  const lifecycle = competitionLifecycle(competition, now);
  // The source response may contain live results; no such fields leave this function.
  if (lifecycle !== 'finished') return { competition, skills, lifecycle };
  if (kind === 'SKILL') {
    const query = new URLSearchParams();
    if (skills.length > 1)
      for (const skill of skills) query.append('metrics', skill);
    const breakdown =
      skills.length > 1
        ? await getWom(base + '?' + query.toString(), request, cancellation)
        : undefined;
    const xp = parseWomSnapshot(source, breakdown, id);
    return {
      competition,
      skills,
      lifecycle,
      results: {
        xp,
        participants: xp.participants.map((p) => ({
          playerId: p.playerId,
          displayName: p.displayName,
          gained: Object.values(p.gains)
            .reduce((sum, n) => sum + BigInt(n!), 0n)
            .toString(),
        })),
      },
    };
  }
  if (
    !instant(source.updatedAt) ||
    !Array.isArray(source.participations) ||
    source.participations.length > 10000 ||
    source.participantCount !== source.participations.length
  )
    throw new ApiError(422, 'Incomplete WOM participant roster.');
  const seen = new Set<number>();
  const participants = source.participations
    .map((p: unknown) => {
      if (
        !obj(p) ||
        typeof p.playerId !== 'number' ||
        !Number.isSafeInteger(p.playerId) ||
        p.playerId <= 0 ||
        seen.has(p.playerId) ||
        !obj(p.player) ||
        typeof p.player.displayName !== 'string' ||
        !p.player.displayName.trim() ||
        !Array.isArray(p.deltas) ||
        p.deltas.length !== 1
      )
        throw new ApiError(422, 'Incomplete or duplicate WOM participant.');
      seen.add(p.playerId);
      const d: unknown = p.deltas[0];
      if (!obj(d) || d.metric !== metrics[0] || !obj(d.values))
        throw new ApiError(422, 'Unavailable activity result.');
      const gained = d.values.gained;
      if (!(
        (typeof gained === 'number' &&
          Number.isSafeInteger(gained) &&
          gained >= 0) ||
        (typeof gained === 'string' && /^(0|[1-9]\d{0,99})$/u.test(gained))
      ))
        throw new ApiError(
          422,
          'Activity gains must be available exact integers.',
        );
      return {
        playerId: p.playerId,
        displayName: p.player.displayName.slice(0, 80),
        gained: String(gained),
      };
    })
    .filter((p) => BigInt(p.gained) > 0n)
    .sort((a, b) => a.playerId - b.playerId);
  return { competition, skills, lifecycle, results: { participants } };
}

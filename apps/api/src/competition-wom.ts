import { createHash } from 'node:crypto';
import {
  competitionLifecycle,
  competitionScope,
  womBossMetrics,
  womActivityMetrics,
  type CompetitionMetricRegistry,
} from '@clog/domain';
import { getWom, parseCompetitionUrl, parseWomSnapshot } from './wom.js';
import type { CompetitionSnapshot } from './competition-types.js';
import {
  womCompetitionMetadata,
  womCompetitionStandings,
  womCompetitionDiscovery,
} from './wom-competition-data.js';

// Boss/activity mappings are independent from computed competition scoring.
export const activityMetrics = new Set<string>([
  ...womBossMetrics,
  ...womActivityMetrics,
]);
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

export const competitionHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function fetchCompetition(
  input: string,
  now: number,
  request: typeof fetch = fetch,
  cancellation: AbortSignal = AbortSignal.timeout(6500),
  resolveMetrics?: () => Promise<CompetitionMetricRegistry>,
): Promise<CompetitionSnapshot> {
  const { id } = parseCompetitionUrl(input);
  const base = 'https://api.wiseoldman.net/v2/competitions/' + id;
  const source = await getWom(base, request, cancellation);
  const discovery = womCompetitionDiscovery(source, id);
  const registry =
    discovery.unknownMetrics.length && resolveMetrics
      ? await resolveMetrics()
      : undefined;
  const competition = womCompetitionMetadata(source, id, registry?.definitions);
  const { skills } = competitionScope(
    competition.metrics,
    competition.metricDefinitions,
  );
  const lifecycle = competitionLifecycle(competition, now);
  const metadata = {
    competition,
    skills,
    lifecycle,
    ...(registry ? { metricRevision: registry.revision } : {}),
  };
  // Running responses can contain live results; metadata imports never retain them.
  if (lifecycle !== 'finished') return metadata;
  if (competition.kind === 'SKILL') {
    const query = new URLSearchParams();
    if (skills.length > 1)
      for (const skill of skills) query.append('metrics', skill);
    const breakdown =
      skills.length > 1
        ? await getWom(base + '?' + query.toString(), request, cancellation)
        : undefined;
    const xp = parseWomSnapshot(source, breakdown, id, registry?.definitions);
    return {
      ...metadata,
      results: { xp, participants: xp.competition!.standings! },
    };
  }
  return {
    ...metadata,
    results: { participants: womCompetitionStandings(source, competition) },
  };
}

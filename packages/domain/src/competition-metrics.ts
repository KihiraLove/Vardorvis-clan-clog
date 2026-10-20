/** Reviewed WOM metric groups; keep synchronized with WOM's official Metric enum. */
import { isSkill, type Skill } from './skills.js';
import type { WomCompetition } from './competitions.js';

export const womBossMetrics = [
  'abyssal_sire',
  'alchemical_hydra',
  'amoxliatl',
  'araxxor',
  'artio',
  'barrows_chests',
  'brutus',
  'bryophyta',
  'callisto',
  'calvarion',
  'cerberus',
  'chambers_of_xeric',
  'chambers_of_xeric_challenge_mode',
  'chaos_elemental',
  'chaos_fanatic',
  'commander_zilyana',
  'corporeal_beast',
  'crazy_archaeologist',
  'dagannoth_prime',
  'dagannoth_rex',
  'dagannoth_supreme',
  'deranged_archaeologist',
  'doom_of_mokhaiotl',
  'duke_sucellus',
  'general_graardor',
  'giant_mole',
  'grotesque_guardians',
  'hespori',
  'kalphite_queen',
  'king_black_dragon',
  'kraken',
  'kreearra',
  'kril_tsutsaroth',
  'lunar_chests',
  'mad_angel',
  'maggot_king',
  'mimic',
  'nex',
  'nightmare',
  'phosanis_nightmare',
  'obor',
  'phantom_muspah',
  'sarachnis',
  'scorpia',
  'scurrius',
  'shellbane_gryphon',
  'skotizo',
  'sol_heredit',
  'spindel',
  'tempoross',
  'the_gauntlet',
  'the_corrupted_gauntlet',
  'the_fractured_archive',
  'the_hueycoatl',
  'the_leviathan',
  'the_royal_titans',
  'the_whisperer',
  'theatre_of_blood',
  'theatre_of_blood_hard_mode',
  'thermonuclear_smoke_devil',
  'tombs_of_amascut',
  'tombs_of_amascut_expert',
  'tzkal_zuk',
  'tztok_jad',
  'vardorvis',
  'venenatis',
  'vetion',
  'vorkath',
  'wintertodt',
  'yama',
  'zalcano',
  'zulrah',
] as const;
export const womActivityMetrics = [
  'bounty_hunter_hunter',
  'bounty_hunter_rogue',
  'clue_scrolls_all',
  'clue_scrolls_beginner',
  'clue_scrolls_easy',
  'clue_scrolls_medium',
  'clue_scrolls_hard',
  'clue_scrolls_elite',
  'clue_scrolls_master',
  'last_man_standing',
  'pvp_arena',
  'soul_wars_zeal',
  'guardians_of_the_rift',
  'colosseum_glory',
  'collections_logged',
] as const;
export function womMetricType(
  metric: string,
): 'SKILL' | 'BOSS' | 'ACTIVITY' | 'COMPUTED' | undefined {
  if (isSkill(metric) || metric === 'overall' || metric === 'total')
    return 'SKILL';
  if ((womBossMetrics as readonly string[]).includes(metric)) return 'BOSS';
  if ((womActivityMetrics as readonly string[]).includes(metric))
    return 'ACTIVITY';
  if (metric === 'ehp' || metric === 'ehb') return 'COMPUTED';
  return undefined;
}
export interface CompetitionMetric {
  metric: string;
  /** Canonical decimal strings preserve weights without floating-point arithmetic. */
  weight: string;
  createdAt?: string;
  /** Frozen installation-defined semantics; never inferred again from a later registry. */
  definition?: CustomCompetitionMetric;
}
export interface CustomCompetitionMetric {
  metric: string;
  name: string;
  type: 'BOSS' | 'ACTIVITY' | 'COMPUTED' | 'SKILL';
  pageIds: string[];
  skill?: Skill;
}
export interface CompetitionMetricRegistry {
  revision: string;
  definitions: CustomCompetitionMetric[];
}
export interface CompetitionMetricDiscovery {
  id: number;
  title: string;
  sourceUrl: string;
  metrics: CompetitionMetric[];
  startsAt: string;
  endsAt: string;
  unknownMetrics: string[];
}
export interface CompetitionMetricResolution extends CompetitionMetricDiscovery {
  resolutionToken: string;
  revision: string;
  expiresAt: string;
  pages: { id: string; name: string }[];
}
export function parseCustomCompetitionMetric(
  value: unknown,
): CustomCompetitionMetric {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid metric definition.');
  const row = value as Record<string, unknown>;
  if (
    typeof row.metric !== 'string' ||
    !/^[a-z][a-z0-9_]{0,79}$/u.test(row.metric) ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name.trim().length > 120 ||
    row.name.includes('\0') ||
    !['BOSS', 'ACTIVITY', 'COMPUTED', 'SKILL'].includes(String(row.type)) ||
    !Array.isArray(row.pageIds) ||
    row.pageIds.length > 200 ||
    row.pageIds.some(
      (id) => typeof id !== 'string' || !id || id.length > 100,
    ) ||
    new Set(row.pageIds).size !== row.pageIds.length ||
    (row.type === 'SKILL' ? !isSkill(row.skill) : row.skill !== undefined) ||
    (['SKILL', 'COMPUTED'].includes(String(row.type)) && row.pageIds.length > 0)
  )
    throw new Error(
      'Choose a valid metric type, name, active pages and supported XP skill.',
    );
  return {
    metric: row.metric,
    name: row.name.trim(),
    type: row.type as CustomCompetitionMetric['type'],
    pageIds: [...(row.pageIds as string[])].sort(),
    ...(row.type === 'SKILL' ? { skill: row.skill as Skill } : {}),
  };
}
export function competitionMetricType(
  metric: string,
  definitions: readonly CompetitionMetric[] = [],
) {
  return (
    definitions.find((d) => d.metric === metric)?.definition?.type ??
    womMetricType(metric)
  );
}
export interface CompetitionStanding {
  playerId: number;
  displayName: string;
  gained: string;
  /** WOM's original order breaks equal-score ties using its start values. */
  rank?: number;
  deltas?: { metric: string; gained: string }[];
}
/** XP/counters are integers; computed metrics and combined scores may be decimal. */
export function competitionAmount(value: unknown, integerOnly = false): string {
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new Error(
        'Competition results must be available exact nonnegative values.',
      );
    const source = String(value);
    if (/e/iu.test(source)) {
      const [mantissa, exponent] = source.toLowerCase().split('e');
      const [whole, fraction = ''] = mantissa!.split('.');
      const digits = whole! + fraction;
      const point = whole!.length + Number(exponent);
      value =
        point <= 0
          ? '0.' + '0'.repeat(-point) + digits
          : point >= digits.length
            ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point);
    } else value = source;
  }
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,99})(?:\.\d{1,100})?$/u.test(value)
  )
    throw new Error(
      'Competition results must be available exact nonnegative values.',
    );
  const normalized = value.includes('.')
    ? value.replace(/0+$/u, '').replace(/\.$/u, '')
    : value;
  if (integerOnly && normalized.includes('.'))
    throw new Error('Competition counters and XP must be integers.');
  return normalized;
}
export function compareCompetitionAmounts(a: string, b: string): number {
  const [ai, af = ''] = a.split('.'),
    [bi, bf = ''] = b.split('.');
  if (ai!.length !== bi!.length) return ai!.length - bi!.length;
  if (ai !== bi) return ai! < bi! ? -1 : 1;
  const length = Math.max(af.length, bf.length);
  return af.padEnd(length, '0').localeCompare(bf.padEnd(length, '0'));
}
export function formatCompetitionAmount(value: string): string {
  const [whole, fraction] = competitionAmount(value).split('.');
  return (
    whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ',') +
    (fraction ? '.' + fraction : '')
  );
}
export function competitionMetricName(metric: string): string {
  if (metric === 'ehp' || metric === 'ehb') return metric.toUpperCase();
  if (metric === 'total') return 'Overall';
  return metric
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
export function competitionDefinitions(
  c: Pick<WomCompetition, 'metrics' | 'metricDefinitions'>,
): CompetitionMetric[] {
  return (
    c.metricDefinitions ?? c.metrics.map((metric) => ({ metric, weight: '1' }))
  );
}
export function parseCompetitionDefinitions(
  value: unknown,
  metrics: readonly string[],
): CompetitionMetric[] {
  if (!Array.isArray(value) || value.length !== metrics.length)
    throw new Error('Incomplete competition metric definitions.');
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid competition metric definition.');
    const row = entry as Record<string, unknown>;
    if (row.metric !== metrics[index])
      throw new Error('Competition metric definitions do not match scope.');
    const weight = competitionAmount(row.weight === undefined ? 1 : row.weight);
    if (weight === '0')
      throw new Error('Competition weights must be positive.');
    if (
      row.createdAt !== undefined &&
      (typeof row.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(row.createdAt)) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(
          row.createdAt,
        ))
    )
      throw new Error('Invalid competition metric creation time.');
    return {
      metric: metrics[index]!,
      weight,
      ...(row.definition === undefined
        ? {}
        : {
            definition: (() => {
              const definition = parseCustomCompetitionMetric(row.definition);
              if (definition.metric !== row.metric)
                throw new Error('Metric definition key does not match scope.');
              return definition;
            })(),
          }),
      ...(row.createdAt === undefined
        ? {}
        : { createdAt: row.createdAt as string }),
    };
  });
}
export function competitionUnit(
  c: Pick<WomCompetition, 'metrics' | 'metricDefinitions'>,
): string {
  if (competitionDefinitions(c).some((d) => d.weight !== '1')) return 'Score';
  const types = new Set(
    c.metrics.map((metric) =>
      competitionMetricType(metric, c.metricDefinitions),
    ),
  );
  if (types.size === 1 && types.has('SKILL'))
    return c.metrics.includes('overall') && c.metrics.length > 1
      ? 'Score'
      : 'XP';
  if (types.size === 1 && types.has('BOSS')) return 'Kills';
  if (types.size === 1 && types.has('COMPUTED')) return 'Hours';
  return 'Score';
}
export function competitionUsesPages(
  metrics: readonly string[],
  definitions: readonly CompetitionMetric[] = [],
): boolean {
  return metrics.some((metric) =>
    ['BOSS', 'ACTIVITY'].includes(
      competitionMetricType(metric, definitions) ?? '',
    ),
  );
}
export function rankedCompetitionStandings(
  players: readonly CompetitionStanding[],
): CompetitionStanding[] {
  return players
    .filter((p) => p.gained !== '0')
    .sort(
      (a, b) =>
        compareCompetitionAmounts(b.gained, a.gained) ||
        (a.rank ?? Number.MAX_SAFE_INTEGER) -
          (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        a.playerId - b.playerId,
    );
}
export function parseCompetitionStandings(
  value: unknown,
  metrics: readonly string[],
  definitions: readonly CompetitionMetric[] = [],
): CompetitionStanding[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error('Invalid competition standings.');
  const seen = new Set<number>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid competition participant.');
    const row = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.playerId) ||
      Number(row.playerId) <= 0 ||
      seen.has(Number(row.playerId)) ||
      typeof row.displayName !== 'string' ||
      !row.displayName.trim() ||
      row.displayName.length > 80 ||
      (row.rank !== undefined &&
        (!Number.isSafeInteger(row.rank) ||
          Number(row.rank) <= 0 ||
          Number(row.rank) > 10000))
    )
      throw new Error('Invalid or duplicate competition participant.');
    seen.add(Number(row.playerId));
    const deltas =
      row.deltas === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(row.deltas))
              throw new Error('Invalid competition deltas.');
            const expected = new Set([
              ...metrics,
              ...(metrics.length > 1 ? ['total'] : []),
            ]);
            if (row.deltas.length !== expected.size)
              throw new Error('Incomplete competition deltas.');
            return row.deltas.map((delta: unknown) => {
              if (!delta || typeof delta !== 'object' || Array.isArray(delta))
                throw new Error('Invalid competition delta.');
              const d = delta as Record<string, unknown>;
              if (typeof d.metric !== 'string' || !expected.delete(d.metric))
                throw new Error('Unexpected or duplicate competition delta.');
              return {
                metric: d.metric,
                gained: competitionAmount(
                  d.gained,
                  d.metric !== 'total' &&
                    competitionMetricType(d.metric, definitions) !== 'COMPUTED',
                ),
              };
            });
          })();
    const gained = competitionAmount(
      row.gained,
      metrics.length === 1 &&
        competitionMetricType(metrics[0]!, definitions) !== 'COMPUTED',
    );
    if (
      deltas &&
      deltas.find(
        (d) => d.metric === (metrics.length > 1 ? 'total' : metrics[0]),
      )?.gained !== gained
    )
      throw new Error('Competition score does not match its metric delta.');
    return {
      playerId: Number(row.playerId),
      displayName: row.displayName,
      gained,
      ...(row.rank === undefined ? {} : { rank: Number(row.rank) }),
      ...(deltas === undefined ? {} : { deltas }),
    };
  });
}

/** RuneLite world flags are a set; retain plugin aliases alongside official names. */
export const blockedRuneLiteWorldTypes: readonly string[] = [
  'BETA_WORLD',
  'DEADMAN',
  'NOSAVE_MODE',
  'PVP_ARENA',
  'QUEST_SPEEDRUNNING',
  'SEASONAL',
  'TOURNAMENT',
  'TOURNAMENT_WORLD',
];
export const hardcoreRuneLiteWorldTypes = [
  'HC_WORLD_PLACEHOLDER',
  'HC_WORLDS_PLACEHOLDER',
] as const;
export function parseRuneLiteWorldTypes(value: unknown): string[] {
  let types: unknown = value;
  if (typeof value === 'string') {
    const text = value.trim();
    types = text.startsWith('[') ? JSON.parse(text) : [text];
  }
  if (
    !Array.isArray(types) ||
    types.length > 32 ||
    types.some(
      (type) =>
        typeof type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(type),
    )
  )
    throw new Error(
      'Use a world type identifier or a JSON array of world type identifiers.',
    );
  return [...new Set(types as string[])].sort();
}

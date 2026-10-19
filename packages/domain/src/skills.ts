/** Canonical WOM identifiers, collection-log display order and local icon metadata. */
export const skills = [
  ['attack', 'Attack', 'attack.webp'],
  ['hitpoints', 'Hitpoints', 'hitpoints.webp'],
  ['mining', 'Mining', 'mining.webp'],
  ['strength', 'Strength', 'strength.webp'],
  ['agility', 'Agility', 'agility.webp'],
  ['smithing', 'Smithing', 'smithing.webp'],
  ['defence', 'Defence', 'defence.webp'],
  ['herblore', 'Herblore', 'herblore.webp'],
  ['fishing', 'Fishing', 'fishing.webp'],
  ['ranged', 'Ranged', 'ranged.webp'],
  ['thieving', 'Thieving', 'thieving.webp'],
  ['cooking', 'Cooking', 'cooking.webp'],
  ['prayer', 'Prayer', 'prayer.webp'],
  ['crafting', 'Crafting', 'crafting.webp'],
  ['firemaking', 'Firemaking', 'firemaking.webp'],
  ['magic', 'Magic', 'magic.webp'],
  ['fletching', 'Fletching', 'fletching.webp'],
  ['woodcutting', 'Woodcutting', 'woodcutting.webp'],
  ['runecrafting', 'Runecraft', 'runecraft.webp'],
  ['slayer', 'Slayer', 'slayer.webp'],
  ['farming', 'Farming', 'farming.webp'],
  ['construction', 'Construction', 'construction.webp'],
  ['hunter', 'Hunter', 'hunter.webp'],
  ['sailing', 'Sailing', 'sailing.webp'],
] as const;
export type Skill = (typeof skills)[number][0];
export const skillIds: readonly Skill[] = skills.map(([id]) => id);
export const isSkill = (value: unknown): value is Skill =>
  skillIds.some((id) => id === value);
export const skillName = (id: Skill) => skills.find(([key]) => key === id)![1];
export const skillIcon = (id: Skill) =>
  '/skills/' + skills.find(([key]) => key === id)![2];

/** Canonical WOM identifiers, collection-log display order and local icon metadata. */
export const skills = [
  ['attack', 'Attack', 'attack.png'],
  ['hitpoints', 'Hitpoints', 'hitpoints.png'],
  ['mining', 'Mining', 'mining.png'],
  ['strength', 'Strength', 'strength.png'],
  ['agility', 'Agility', 'agility.png'],
  ['smithing', 'Smithing', 'smithing.png'],
  ['defence', 'Defence', 'defence.png'],
  ['herblore', 'Herblore', 'herblore.png'],
  ['fishing', 'Fishing', 'fishing.png'],
  ['ranged', 'Ranged', 'ranged.png'],
  ['thieving', 'Thieving', 'thieving.png'],
  ['cooking', 'Cooking', 'cooking.png'],
  ['prayer', 'Prayer', 'prayer.png'],
  ['crafting', 'Crafting', 'crafting.png'],
  ['firemaking', 'Firemaking', 'firemaking.png'],
  ['magic', 'Magic', 'magic.png'],
  ['fletching', 'Fletching', 'fletching.png'],
  ['woodcutting', 'Woodcutting', 'woodcutting.png'],
  ['runecrafting', 'Runecraft', 'runecraft.png'],
  ['slayer', 'Slayer', 'slayer.png'],
  ['farming', 'Farming', 'farming.png'],
  ['construction', 'Construction', 'construction.png'],
  ['hunter', 'Hunter', 'hunter.png'],
  ['sailing', 'Sailing', 'sailing.png'],
] as const;
export type Skill = (typeof skills)[number][0];
export const skillIds: readonly Skill[] = skills.map(([id]) => id);
export const isSkill = (value: unknown): value is Skill =>
  skillIds.some((id) => id === value);
export const skillName = (id: Skill) => skills.find(([key]) => key === id)![1];
export const skillIcon = (id: Skill) =>
  '/skills/' + skills.find(([key]) => key === id)![2];

/** Optional submitted names are evidence, never a catalog matching key. */
import { ApiError } from './types.js';

export function validateRuneLiteItemName(name: string | undefined) {
  if (
    name !== undefined &&
    (!name.trim() || name.length > 200 || name.includes('\0'))
  )
    throw new ApiError(
      422,
      'Supply a nonempty item name of up to 200 characters without NUL.',
    );
}

/** Recognized client message formats only; retain the untouched message separately. */
export function runeLiteItemName(
  fields: {
    itemName?: string;
    itemId: number;
    chatMessage?: string;
  },
  catalogName?: string,
) {
  if (fields.itemName !== undefined) return fields.itemName;
  if (catalogName !== undefined) return catalogName;
  const clean =
    fields.chatMessage
      ?.replace(/<[^>]*>/gu, '')
      .replaceAll('\u00a0', ' ')
      .trim() ?? '';
  const patterns = [
    /^New item added to your collection log: (.+)$/u,
    /^(?:Valuable|Untradeable) drop: (.+?)(?: \([\d,]+ coins\))?$/u,
    /^.+? received a new collection log item: (.+?)(?: \([\d,]+\/[\d,]+\))?[!.]?$/u,
    /^.+? (?:received a (?:valuable )?drop|received special loot from a raid): (.+?) \([\d,]+(?: coins)?\)(?: from .+)?[!.]?$/u,
    /^(?:\[[^\]]+\]\s*)?.+? (?:has|have) a funny feeling like (?:(?:he['’]s|she['’]s|they['’]re) being followed|(?:he|she|they) would have been followed): (.+?) at [\d,]+ killcount[!.]?$/u,
    /^.+? has received a drop: ([\d,]+ x .+?)[!.]?$/u,
  ];
  for (const pattern of patterns) {
    const name = pattern
      .exec(clean)?.[1]
      ?.replace(/^[\d,]+ x /u, '')
      .trim();
    if (name && name.length <= 200) return name;
  }
  return `Name not supplied — game item #${fields.itemId}`;
}

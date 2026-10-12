/** Administrator-editable public labels with one shared validation contract. */
export const defaultSiteCopy = {
  collectionTitle: 'Clan Collection Log',
  collectionCaption: 'Collected during BOTW events',
  xpTitle: 'XP gained during SOTW events',
};
export type SiteCopy = typeof defaultSiteCopy;
export interface HardcoreAppearance {
  clanName: string;
  copy: SiteCopy;
}
export function parseHardcoreAppearance(value: unknown): HardcoreAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid hardcore appearance.');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    typeof data.clanName !== 'string' ||
    !data.clanName.trim() ||
    data.clanName.trim().length > 80 ||
    Array.from(data.clanName).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      'Hardcore clan name must contain 1–80 printable characters.',
    );
  return { clanName: data.clanName.trim(), copy: parseSiteCopy(data.copy) };
}
export function parseSiteCopy(value: unknown): SiteCopy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid website text.');
  const data = value as Record<string, unknown>;
  const keys = Object.keys(defaultSiteCopy) as (keyof SiteCopy)[];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some(
      (key) =>
        typeof data[key] !== 'string' ||
        !(data[key] as string).trim() ||
        (data[key] as string).length > 160 ||
        Array.from(data[key] as string).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error(
      'Each website text must contain 1–160 printable characters.',
    );
  return Object.fromEntries(
    keys.map((key) => [key, (data[key] as string).trim()]),
  ) as SiteCopy;
}

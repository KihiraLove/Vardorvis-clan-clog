/** Admin-only key contracts; public site settings never include these values. */
export interface ClanKeySettings {
  revision: string;
  enabled: boolean;
  key: string;
}
export interface ClanKeyUpdate {
  expectedRevision: string;
  enabled?: boolean;
  key?: string;
  generate?: true;
}
export const validClanKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[\x20-\x7e]{1,256}$/u.test(value) &&
  value === value.trim() &&
  value.length > 0;
export function parseClanKey(value: unknown): ClanKeySettings {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid API key settings.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.revision !== 'string' ||
    !/^clan-key-[1-9][0-9]*$/u.test(data.revision) ||
    typeof data.enabled !== 'boolean' ||
    !validClanKey(data.key)
  )
    throw new Error('Invalid API key settings.');
  return { revision: data.revision, enabled: data.enabled, key: data.key };
}

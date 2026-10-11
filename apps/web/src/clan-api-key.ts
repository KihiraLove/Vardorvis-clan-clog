/** Admin-only key contracts; public site settings never include these values. */
import { validClanApiKey } from '@clog/domain';
export { validClanApiKey as validClanKey } from '@clog/domain';
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
export function parseClanKey(value: unknown): ClanKeySettings {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid API key settings.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.revision !== 'string' ||
    !/^clan-key-[1-9][0-9]*$/u.test(data.revision) ||
    typeof data.enabled !== 'boolean' ||
    !validClanApiKey(data.key)
  )
    throw new Error('Invalid API key settings.');
  return { revision: data.revision, enabled: data.enabled, key: data.key };
}

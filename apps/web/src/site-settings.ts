/** Versioned release visibility; missing public settings must fail closed. */
export interface SiteSettings {
  revision: string;
  hardcoreEnabled: boolean;
}
export function parseSettings(value: unknown): SiteSettings {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid site settings.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.revision !== 'string' ||
    !data.revision.trim() ||
    typeof data.hardcoreEnabled !== 'boolean'
  )
    throw new Error('Invalid site settings.');
  return { revision: data.revision, hardcoreEnabled: data.hardcoreEnabled };
}

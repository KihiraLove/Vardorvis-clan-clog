/** Versioned release visibility; missing public settings must fail closed. */
export interface SiteSettings {
  eventHighlight?: HighlightColour;
  hardcoreHighlight?: HighlightColour;
  howToSubmitMarkdown?: string;
  copy?: SiteCopy;
  hardcore?: HardcoreAppearance;
  revision: string;
  clanName: string;
  hardcoreEnabled: boolean;
}
export function parseSettings(value: unknown): SiteSettings {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid site settings.');
  const data = value as Record<string, unknown>;
  if (
    typeof data.revision !== 'string' ||
    !data.revision.trim() ||
    typeof data.hardcoreEnabled !== 'boolean' ||
    typeof data.clanName !== 'string' ||
    !data.clanName.trim() ||
    data.clanName.length > 80
  )
    throw new Error('Invalid site settings.');
  return {
    ...(data.eventHighlight === undefined
      ? {}
      : { eventHighlight: parseHighlightColour(data.eventHighlight) }),
    ...(data.hardcoreHighlight === undefined
      ? {}
      : { hardcoreHighlight: parseHighlightColour(data.hardcoreHighlight) }),
    revision: data.revision,
    hardcoreEnabled: data.hardcoreEnabled,
    clanName: data.clanName,
    ...(data.howToSubmitMarkdown === undefined
      ? {}
      : { howToSubmitMarkdown: parseSubmissionHelp(data.howToSubmitMarkdown) }),
    ...(data.copy === undefined ? {} : { copy: parseSiteCopy(data.copy) }),
    ...(data.hardcore === undefined
      ? {}
      : { hardcore: parseHardcoreAppearance(data.hardcore) }),
  };
}
import {
  parseHighlightColour,
  type HighlightColour,
  parseSubmissionHelp,
  parseSiteCopy,
  parseHardcoreAppearance,
  type SiteCopy,
  type HardcoreAppearance,
} from '@clog/domain';

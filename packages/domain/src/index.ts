/** Pure collection-log rules shared by the browser and future service handlers. */
export * from './competitions.js';
export * from './skills.js';
export * from './collection-types.js';
export * from './submission-help.js';
export interface CatalogItem {
  id: number;
  name: string;
  gameItemIds: number[];
}

export interface CatalogPage {
  id: string;
  itemIds: number[];
}

export interface CollectionCredit {
  submissionId: string;
  itemId: number;
  collectorName: string;
  collectedOn: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  hardcore?: boolean;
  collectionType?: import('./collection-types.js').CollectionType;
}

/** Collection state belongs to the canonical item, never to a page occurrence. */
export function collectionState(
  itemId: number,
  submissions: readonly CollectionCredit[],
  hardcore?: boolean,
) {
  const collectors = submissions
    .filter(
      (entry) =>
        entry.itemId === itemId &&
        entry.status === 'approved' &&
        (hardcore === undefined || (entry.hardcore ?? false) === hardcore),
    )
    .sort(
      (a, b) =>
        Number(b.collectionType === 'event') -
          Number(a.collectionType === 'event') ||
        a.collectedOn.localeCompare(b.collectedOn) ||
        a.submissionId.localeCompare(b.submissionId),
    );
  return { collected: collectors.length > 0, collectors };
}

/** Validate the imported catalog graph, including globally unambiguous game-ID aliases.
 * Manual items may omit external IDs; imported items require them at the import boundary.
 */
export function validateCatalog(
  items: readonly CatalogItem[],
  pages: readonly CatalogPage[],
): void {
  const itemIds = new Set<number>();
  const gameIds = new Set<number>();
  for (const item of items) {
    if (
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      itemIds.has(item.id) ||
      !item.name.trim()
    ) {
      throw new Error('Invalid or duplicate canonical item');
    }
    itemIds.add(item.id);
    for (const gameId of item.gameItemIds) {
      if (!Number.isSafeInteger(gameId) || gameId <= 0 || gameIds.has(gameId))
        throw new Error('Invalid or ambiguous game item mapping');
      gameIds.add(gameId);
    }
  }
  const pageIds = new Set<string>();
  for (const page of pages) {
    if (!page.id.trim() || pageIds.has(page.id))
      throw new Error('Invalid or duplicate page');
    pageIds.add(page.id);
    if (
      new Set(page.itemIds).size !== page.itemIds.length ||
      page.itemIds.some((id) => !itemIds.has(id))
    ) {
      throw new Error('Invalid page item reference');
    }
  }
}

/** Round-trip through UTC to reject normalized invalid dates such as February 30. */
export function validateCollectionDate(input: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input)) throw new Error('Use YYYY-MM-DD');
  const parsed = new Date(`${input}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== input
  )
    throw new Error('Invalid calendar date');
  return input;
}

/** Format a calendar date without letting the viewer's timezone shift its day. */
export function formatCollectionDate(input: string): string {
  validateCollectionDate(input);
  return `${input.slice(8, 10)}/${input.slice(5, 7)}/${input.slice(2, 4)}`;
}
export {
  defaultSiteCopy,
  parseSiteCopy,
  parseHardcoreAppearance,
  type SiteCopy,
  type HardcoreAppearance,
} from './site-copy.js';
export { clanKeyBytes, clanKeyMinLength, validClanApiKey } from './clan-key.js';
export {
  defaultDiscordLimits,
  discordSnowflake,
  parseDiscordFields,
  parseDiscordSettings,
  type DiscordFields,
  type DiscordLimits,
  type DiscordSettings,
  type DiscordSettingsUpdate,
} from './discord-settings.js';
export {
  blockedRuneLiteWorldTypes,
  hardcoreRuneLiteWorldTypes,
  parseRuneLiteWorldTypes,
} from './world-types.js';
export {
  defaultRuneLiteRules,
  normalizePlayerName,
  parseRuneLiteRules,
  parseRuneLiteSettings,
  runeLiteDecision,
  type WorldPolicy,
  type RuneLiteRules,
  type RuneLiteSettings,
  type RuneLiteSettingsUpdate,
} from './runelite-rules.js';
export {
  parseCollectionScheduleInput,
  parseSchedulingState,
  parsePermanentPageIds,
  scheduleIdPattern,
  scheduledItemOpen,
  closedCollectionPageMessage,
  type CollectionScheduleInput,
  type CollectionSchedule,
  type SchedulingState,
} from './scheduling.js';
export { WorkBudget, WorkloadError, type WorkLimit } from './work-budget.js';
export {
  staffPages,
  defaultModeratorPages,
  parseStaffPages,
  parseAccessControl,
  staffPageForPath,
  canAccessStaffPage,
  type StaffPage,
  type AccessControlSettings,
} from './staff-pages.js';
export {
  parseSubmissionFilters,
  type SubmissionFilters,
} from './submission-filters.js';
export {
  OperationalDiagnostics,
  WorkDrain,
  withinDeadline,
  safeFailure,
  safeCorrelation,
  type ErrorCategory,
} from './operations.js';

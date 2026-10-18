/** Private API contracts and form validation; server authorization remains mandatory. */
import {
  validateCollectionDate,
  validateProofUrl,
  parseSubmissionFilters,
} from '@clog/domain';
import { parseCatalog, type Catalog, type Item, type Page } from './model.ts';
import {
  identity,
  list,
  object,
  text,
  timestamp,
  unique,
  type AdminSession,
} from './xp-model.ts';

export type QueueView = 'pending' | 'unmatched' | 'reviewed';
export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
export function dateSourceLabel(source: Submission['dateSource']): string {
  return source === 'submission'
    ? 'Submission date'
    : source === 'claim'
      ? 'Collector supplied'
      : 'Admin correction';
}
export interface Submission {
  id: string;
  version: number;
  source: 'discord' | 'manual' | 'runelite';
  itemId: number | null;
  rawItemText: string;
  collectorName: string;
  collectedOn: string;
  dateSource: 'submission' | 'claim' | 'admin';
  submittedAt: string;
  proofUrl: string;
  screenshotPath?: string | null;
  chatMessage?: string;
  hardcore: boolean;
  status: SubmissionStatus;
  reviewNote: string;
  reviewReason: string | null;
}
export interface ManualSubmissionInput {
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
  proofUrl?: string;
  approve: boolean;
  reason?: string;
}
export interface Correction {
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
  reason: string;
}
export interface AuditEntry {
  id: string;
  actorName: string;
  at: string;
  action: 'create' | 'edit' | 'approve' | 'reject' | 'revoke';
  reason: string | null;
  before: Submission;
  after: Submission;
}
export interface SubmissionDetail {
  submission: Submission;
  audit: AuditEntry[];
  auditRevision: string;
  auditCursor: string;
  nextAuditCursor: string | null;
}
export interface QueueResult {
  filters?: import('@clog/domain').SubmissionFilters;
  revision: string;
  submissions: Submission[];
  nextCursor: string | null;
  pageCursor: string;
}
export interface AdminItem extends Item {
  gameItemIds?: number[];
  origin: 'source' | 'manual';
  overrides: ('name' | 'icon' | 'pages' | 'game_ids')[];
}
export interface AdminPage extends Page {
  version: string;
  orderOrigin: 'source' | 'manual';
}
export interface AdminCatalog extends Catalog {
  collectedItemIds?: number[];
  sourceRevision: string | null;
  items: AdminItem[];
  pages: AdminPage[];
}
export interface StagedIcon {
  assetId: string;
  iconPath: string;
  expiresAt: string;
}
export interface CreateItem {
  gameItemIds: number[];
  name: string;
  iconAssetId: string;
  pageIds: string[];
}
export interface CreatedItem {
  item: AdminItem;
  pageIds: string[];
  catalogRevision: string;
}
export interface CreatePage {
  name: string;
  category: import('./model.ts').Category;
  itemIds: number[];
}
export interface StaffAccount {
  disabled?: boolean;
  version?: number;
  id: string;
  username: string;
  role: 'admin' | 'moderator';
  mustChangePassword: boolean;
}
export function parseStaffAccount(input: unknown): StaffAccount {
  const value = object(input);
  if (
    !['admin', 'moderator'].includes(String(value.role)) ||
    typeof value.mustChangePassword !== 'boolean' ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    (value.version !== undefined &&
      (!Number.isInteger(value.version) || Number(value.version) < 1))
  )
    throw new Error('Invalid staff account.');
  return {
    id: text(value.id),
    username: text(value.username),
    role: value.role as StaffAccount['role'],
    mustChangePassword: value.mustChangePassword,
    ...(value.disabled === undefined
      ? {}
      : { disabled: value.disabled as boolean }),
    ...(value.version === undefined
      ? {}
      : { version: value.version as number }),
  };
}
export interface AdminClient {
  accessControl(
    signal: AbortSignal,
  ): Promise<import('@clog/domain').AccessControlSettings>;
  saveAccessControl(
    pages: import('@clog/domain').StaffPage[],
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').AccessControlSettings>;
  createSection(
    name: string,
    key: string,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<{ id: string; name: string }>;
  editSection(
    id: string,
    name: string | null,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  reorderSections(
    ids: string[],
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  renamePage(
    id: string,
    name: string,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  attachItem(
    pageId: string,
    id: number,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  editItem(
    id: number,
    fields: { name: string; gameItemIds: number[]; iconAssetId?: string },
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  deleteItem(
    id: number,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  saveSubmissionFilters(
    filterCollected: boolean,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').SubmissionFilters>;
  scheduling(
    signal: AbortSignal,
  ): Promise<import('@clog/domain').SchedulingState>;
  setSchedulingEnabled(
    enabled: boolean,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').SchedulingState>;
  saveSchedule(
    input: import('@clog/domain').CollectionScheduleInput,
    revision: string,
    csrf: string,
    signal: AbortSignal,
    id?: string,
  ): Promise<import('@clog/domain').SchedulingState>;
  deleteSchedule(
    id: string,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').SchedulingState>;
  createPage(
    fields: CreatePage,
    key: string,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<AdminPage>;
  removePage(
    id: string,
    revision: string,
    version: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<{ retiredItemIds: number[] }>;
  reorderPages(
    category: import('./model.ts').Category,
    ids: string[],
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  manageModerator(
    id: string,
    expectedVersion: number,
    action: 'disable' | 'enable' | 'delete',
    csrf: string,
    signal: AbortSignal,
  ): Promise<StaffAccount>;
  removePageItem(
    pageId: string,
    id: number,
    revision: string,
    version: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<{ retired: boolean }>;
  branding(
    signal: AbortSignal,
    hardcore?: boolean,
  ): Promise<import('./branding.ts').Branding>;
  saveLogo(
    file: File | null,
    revision: string,
    csrf: string,
    signal: AbortSignal,
    hardcore?: boolean,
  ): Promise<import('./branding.ts').Branding>;
  accounts(signal: AbortSignal): Promise<StaffAccount[]>;
  createModerator(
    username: string,
    password: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<StaffAccount>;
  updateAccount(
    fields: { username: string; currentPassword: string; newPassword?: string },
    csrf: string,
    signal: AbortSignal,
  ): Promise<AdminSession>;
  clanApiKey(
    signal: AbortSignal,
  ): Promise<import('./clan-api-key.ts').ClanKeySettings>;
  discordSettings(
    signal: AbortSignal,
  ): Promise<import('@clog/domain').DiscordSettings>;
  discordStatus(
    signal: AbortSignal,
  ): Promise<{ enabled: boolean; ready: boolean }>;
  saveDiscordSettings(
    fields: import('@clog/domain').DiscordSettingsUpdate,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').DiscordSettings>;
  registerDiscordCommands(
    target: 'guild' | 'test',
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<void>;
  runeLiteSettings(
    signal: AbortSignal,
  ): Promise<import('@clog/domain').RuneLiteSettings>;
  saveRuneLiteSettings(
    fields: import('@clog/domain').RuneLiteSettingsUpdate,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('@clog/domain').RuneLiteSettings>;
  saveClanApiKey(
    fields: import('./clan-api-key.ts').ClanKeyUpdate,
    csrf: string,
    signal: AbortSignal,
  ): Promise<import('./clan-api-key.ts').ClanKeySettings>;
  settings(
    signal: AbortSignal,
  ): Promise<import('./site-settings.ts').SiteSettings>;
  saveSettings(
    enabled: boolean,
    revision: string,
    csrf: string,
    signal: AbortSignal,
    clanName?: string,
    copy?: import('@clog/domain').SiteCopy,
    hardcore?: import('@clog/domain').HardcoreAppearance,
  ): Promise<import('./site-settings.ts').SiteSettings>;
  session(signal: AbortSignal): Promise<AdminSession | null>;
  login(username: string, password: string, signal: AbortSignal): Promise<void>;
  addManual(
    fields: ManualSubmissionInput,
    key: string,
    csrf: string,
    signal: AbortSignal,
    screenshot?: File,
  ): Promise<Submission>;
  logout(csrf: string, signal: AbortSignal): Promise<void>;
  catalog(signal: AbortSignal): Promise<AdminCatalog>;
  queue(
    view: QueueView,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<QueueResult>;
  detail(
    id: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<SubmissionDetail>;
  edit(
    id: string,
    version: number,
    fields: Correction,
    csrf: string,
    signal: AbortSignal,
  ): Promise<Submission>;
  saveReviewNote(
    id: string,
    version: number,
    note: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<Submission>;
  decide(
    id: string,
    version: number,
    action: 'approve' | 'reject' | 'revoke',
    reason: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<Submission>;
  upload(file: File, csrf: string, signal: AbortSignal): Promise<StagedIcon>;
  create(
    fields: CreateItem,
    key: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<CreatedItem>;
  order(
    pageId: string,
    ids: number[],
    version: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<AdminPage>;
}

/** Keep malformed claims reviewable/rejectable while withholding an unsafe proof link. */
export function safeProof(input: string): string | undefined {
  try {
    return validateProofUrl(input);
  } catch {
    return undefined;
  }
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error('Invalid admin response.');
  return value as T;
}
export function safeScreenshotPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\/api\/v1\/admin\/submission-images\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.png$/u.test(
      value,
    )
  );
}
function parseScreenshotPath(value: unknown) {
  if (value === null || safeScreenshotPath(value)) return value;
  throw new Error('Invalid screenshot path.');
}
export function parseSubmission(value: unknown): Submission {
  const row = object(value);
  if (
    typeof row.hardcore !== 'boolean' ||
    typeof row.rawItemText !== 'string' ||
    typeof row.proofUrl !== 'string' ||
    (row.chatMessage !== undefined &&
      (row.source !== 'runelite' ||
        typeof row.chatMessage !== 'string' ||
        !row.chatMessage.trim() ||
        row.chatMessage.length > 8192))
  )
    throw new Error('Invalid submission data.');
  return {
    id: text(row.id),
    version: identity(row.version),
    source:
      row.source === undefined
        ? 'discord'
        : choice(row.source, ['discord', 'manual', 'runelite']),
    itemId: row.itemId === null ? null : identity(row.itemId),
    rawItemText: row.rawItemText,
    collectorName: text(row.collectorName),
    collectedOn: validateCollectionDate(text(row.collectedOn)),
    dateSource: choice(row.dateSource, ['submission', 'claim', 'admin']),
    submittedAt: timestamp(row.submittedAt),
    // Manual submissions may have no proof; bot claims must provide evidence.
    proofUrl: row.proofUrl,
    ...(row.chatMessage === undefined
      ? {}
      : { chatMessage: row.chatMessage as string }),
    ...(row.screenshotPath === undefined
      ? {}
      : { screenshotPath: parseScreenshotPath(row.screenshotPath) }),
    hardcore: row.hardcore,
    status: choice(row.status, ['pending', 'approved', 'rejected', 'revoked']),
    // Empty defaults keep existing review fixtures and older snapshots usable.
    reviewNote:
      row.reviewNote === undefined
        ? ''
        : typeof row.reviewNote === 'string' && row.reviewNote.length <= 1000
          ? row.reviewNote
          : (() => {
              throw new Error('Invalid saved review note.');
            })(),
    reviewReason:
      row.reviewReason === undefined || row.reviewReason === null
        ? null
        : text(row.reviewReason),
  };
}
/** Verify status boundaries as well as row shape so a response cannot change queue meaning. */
export function parseQueue(value: unknown, view: QueueView): QueueResult {
  const data = object(value),
    submissions = list(data.submissions).map(parseSubmission);
  unique(submissions.map((s) => s.id));
  if (submissions.length > 20)
    throw new Error('Queue page exceeds supported size.');
  if (
    submissions.some((s) =>
      view === 'reviewed'
        ? s.status === 'pending'
        : s.status !== 'pending' || (view === 'unmatched' && s.itemId !== null),
    )
  )
    throw new Error('Unexpected submission view.');
  return {
    ...(data.filters === undefined
      ? {}
      : { filters: parseSubmissionFilters(data.filters) }),
    revision: text(data.revision),
    submissions,
    nextCursor: data.nextCursor === null ? null : text(data.nextCursor),
    pageCursor: text(data.pageCursor),
  };
}
/** Every before/after audit snapshot must refer to the selected submission. */
export function parseDetail(value: unknown): SubmissionDetail {
  const data = object(value),
    submission = parseSubmission(data.submission);
  const audit = list(data.audit).map((entry) => {
    const a = object(entry),
      before = parseSubmission(a.before),
      after = parseSubmission(a.after);
    if (before.id !== submission.id || after.id !== submission.id)
      throw new Error('Unexpected audit identity.');
    return {
      id: text(a.id),
      actorName: text(a.actorName),
      at: timestamp(a.at),
      action: choice(a.action, [
        'create',
        'edit',
        'approve',
        'reject',
        'revoke',
      ]),
      reason: a.reason === null ? null : text(a.reason),
      before,
      after,
    };
  });
  unique(audit.map((a) => a.id));
  if (audit.length > 20) throw new Error('Audit page exceeds supported size.');
  return {
    submission,
    audit,
    auditRevision: text(data.auditRevision),
    auditCursor: text(data.auditCursor),
    nextAuditCursor:
      data.nextAuditCursor === null ? null : text(data.nextAuditCursor),
  };
}
export function parseAdminItem(value: unknown): AdminItem {
  const data = object(value);
  const item = parseCatalog({ revision: 'item', items: [data], pages: [] })
    .items[0]!;
  const overrides = list(data.overrides).map((v) =>
    choice(v, ['name', 'icon', 'pages', 'game_ids'] as const),
  );
  unique(overrides);
  return {
    ...item,
    origin: choice(data.origin, ['source', 'manual']),
    overrides,
    gameItemIds:
      data.gameItemIds === undefined
        ? []
        : list(data.gameItemIds).map(identity),
  };
}
export function parseAdminPage(value: unknown): AdminPage {
  const page = object(value),
    itemIds = list(page.itemIds).map(identity);
  unique(itemIds);
  const category = text(page.category);
  return {
    id: text(page.id),
    name: text(page.name),
    category,
    itemIds,
    version: text(page.version),
    orderOrigin: choice(page.orderOrigin, ['source', 'manual']),
  };
}
/** Extend the public graph with source/manual provenance and page concurrency versions. */
export function parseAdminCatalog(value: unknown): AdminCatalog {
  const data = object(value),
    base = parseCatalog(data);
  const metadata = new Map(
    list(data.pages).map((entry) => {
      const page = object(entry);
      return [
        text(page.id),
        {
          version: text(page.version),
          orderOrigin: choice(page.orderOrigin, ['source', 'manual']),
        },
      ] as const;
    }),
  );
  return {
    ...base,
    collectedItemIds:
      data.collectedItemIds === undefined
        ? []
        : list(data.collectedItemIds).map(identity),
    sourceRevision:
      data.sourceRevision === null ? null : text(data.sourceRevision),
    items: list(data.items).map(parseAdminItem),
    pages: base.pages.map((page) => ({ ...page, ...metadata.get(page.id)! })),
  };
}
/** Corrections require an exact canonical match; display-name similarity is insufficient. */
export function validateCorrection(
  fields: Correction,
  catalog: Catalog,
): Correction {
  if (!catalog.items.some((item) => item.id === fields.itemId))
    throw new Error(
      'Select a specific catalog item before saving or approving.',
    );
  const collectorName = fields.collectorName.trim(),
    reason = fields.reason.trim();
  if (!collectorName || collectorName.length > 80)
    throw new Error('Enter a collector name of 1–80 characters.');
  if (reason.length > 1000)
    throw new Error('Keep the review reason to 1,000 characters.');
  if (typeof fields.hardcore !== 'boolean')
    throw new Error('Invalid hardcore claim.');
  return {
    ...fields,
    collectorName,
    reason,
    collectedOn: validateCollectionDate(fields.collectedOn),
  };
}
/** New manual items need a game identity, staged icon and existing page. */
export function validateItem(fields: CreateItem, catalog: Catalog): CreateItem {
  const name = fields.name.trim();
  if (!name || name.length > 200)
    throw new Error('Enter an item name of 1–200 characters.');
  if (!fields.iconAssetId.trim())
    throw new Error('Choose and upload an item icon.');
  if (
    !fields.gameItemIds?.length ||
    fields.gameItemIds.length > 100 ||
    new Set(fields.gameItemIds).size !== fields.gameItemIds.length ||
    fields.gameItemIds.some(
      (id) => !Number.isInteger(id) || id < 1 || id > 2147483647,
    )
  )
    throw new Error('Enter distinct positive in-game item IDs.');
  if (
    !fields.pageIds.length ||
    new Set(fields.pageIds).size !== fields.pageIds.length ||
    fields.pageIds.some((id) => !catalog.pages.some((page) => page.id === id))
  )
    throw new Error('Select one or more existing collection-log pages.');
  return { ...fields, name };
}

export function parseGameItemIds(value: string): number[] {
  const tokens = value.trim().split(/[\s,]+/u);
  if (!value.trim() || tokens.some((token) => !/^\d+$/u.test(token)))
    throw new Error('Enter positive in-game item IDs separated by commas.');
  const ids = tokens.map(Number);
  if (
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647)
  )
    throw new Error('Enter distinct positive in-game item IDs.');
  return ids;
}
/** An order edit must be a permutation, with no added, missing or duplicate memberships. */
export function validateOrder(
  current: readonly number[],
  next: readonly number[],
): void {
  if (
    current.length !== next.length ||
    new Set(next).size !== next.length ||
    next.some((id) => !current.includes(id))
  )
    throw new Error(
      'An order must contain every current page item exactly once.',
    );
}
/** Return a new ordered array for drag, keyboard and button controls to share. */
export function moveItem(
  ids: readonly number[],
  from: number,
  to: number,
): number[] {
  if (
    ![from, to].every(
      (index) => Number.isInteger(index) && index >= 0 && index < ids.length,
    )
  )
    throw new Error('Invalid item position.');
  const next = [...ids],
    [id] = next.splice(from, 1);
  next.splice(to, 0, id!);
  return next;
}
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MAX_ICON_SIZE = 512;
/** Check size, MIME and signature before decode/upload; this is not server validation. */
export async function validateIconFile(file: File): Promise<void> {
  if (
    !['image/png', 'image/webp'].includes(file.type) ||
    !file.size ||
    file.size > MAX_ICON_BYTES
  )
    throw new Error('Choose a PNG or WebP icon up to 2 MiB.');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (value, i) => bytes[i] === value,
  );
  const webp =
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (
    (file.type === 'image/png' && !png) ||
    (file.type === 'image/webp' && !webp)
  )
    throw new Error('The icon content does not match its PNG/WebP file type.');
}
/** Enforce decoded dimensions after createImageBitmap has verified the image is readable. */
export function validateIconSize(width: number, height: number): void {
  if (
    ![width, height].every(
      (n) => Number.isInteger(n) && n > 0 && n <= MAX_ICON_SIZE,
    )
  )
    throw new Error('Icon width and height must be between 1 and 512 pixels.');
}

/** Test-only API state; never imported by application code. */
import {
  validClanKey,
  type ClanKeySettings,
  type ClanKeyUpdate,
} from '../../src/clan-api-key.ts';
const generateFixtureKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(clanKeyBytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
import { AdminRequestError } from '../../src/admin-api.ts';
import {
  defaultSiteCopy,
  defaultSubmissionHelp,
  parseSubmissionHelp,
  parseSiteCopy,
  parseHardcoreAppearance,
  type SiteCopy,
  type HardcoreAppearance,
  clanKeyBytes,
  defaultRuneLiteRules,
  parseRuneLiteRules,
  type RuneLiteSettings,
  type RuneLiteSettingsUpdate,
  parseCollectionScheduleInput,
  parsePermanentPageIds,
  type SchedulingState,
  type CollectionScheduleInput,
} from '@clog/domain';
import { defaultBranding, type Branding } from '../../src/branding.ts';
import {
  safeScreenshotPath,
  validateCorrection,
  validateIconFile,
  validateItem,
  validateOrder,
  type AdminCatalog,
  type AdminClient,
  type AdminPage,
  type AuditEntry,
  type Correction,
  type CollectionFlags,
  type ManualSubmissionInput,
  type CreatedItem,
  type CreateItem,
  type CreatePage,
  type QueueView,
  type StagedIcon,
  type Submission,
  type StaffAccount,
} from '../../src/admin-model.ts';
import { catalogSections, type LogData } from '../../src/model.ts';
import {
  fixtureCatalog,
  fixtureCollections,
  type Scenario,
} from './scenarios.ts';

export class MemoryAdminClient implements AdminClient {
  private accessState: import('@clog/domain').AccessControlSettings = {
    revision: 'access-control-1',
    moderatorPages: ['submissions', 'catalog', 'schedules', 'runelite'],
  };
  async accessControl(signal: AbortSignal) {
    this.access(signal);
    return structuredClone(this.accessState);
  }
  async saveAccessControl(
    pages: import('@clog/domain').StaffPage[],
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (revision !== this.accessState.revision)
      throw new AdminRequestError(409);
    this.accessState = {
      revision: 'access-control-' + (Number(revision.slice(15)) + 1),
      moderatorPages: [...pages],
    };
    return this.accessControl(signal);
  }
  private discordState: import('@clog/domain').DiscordSettings = {
    revision: 'discord-1',
    enabled: false,
    applicationId: '',
    guildId: '',
    testGuildId: '',
    tokenConfigured: false,
    limits: {
      intakeUser: 5,
      intakeGuild: 60,
      searchUser: 30,
      searchGuild: 300,
    },
  };
  async discordSettings(signal: AbortSignal) {
    this.access(signal);
    if (
      this.staff.find((account) => account.username === this.username)?.role !==
      'admin'
    )
      throw new AdminRequestError(403);
    return structuredClone(this.discordState);
  }
  async discordStatus(signal: AbortSignal) {
    this.access(signal);
    return {
      enabled: this.discordState.enabled,
      ready: false,
      state: this.discordState.enabled
        ? ('disconnected' as const)
        : ('disabled' as const),
    };
  }
  async saveDiscordSettings(
    input: import('@clog/domain').DiscordSettingsUpdate,
    _csrf: string,
    signal: AbortSignal,
  ) {
    const old = await this.discordSettings(signal);
    if (input.expectedRevision !== old.revision)
      throw new AdminRequestError(409);
    const { expectedRevision, token, ...fields } = input;
    this.discordState = {
      ...fields,
      revision: 'discord-' + (Number(expectedRevision.slice(8)) + 1),
      tokenConfigured: token === undefined ? old.tokenConfigured : !!token,
    };
    return this.discordSettings(signal);
  }
  async registerDiscordCommands(
    _target: 'guild' | 'test',
    _revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    await this.discordSettings(signal);
  }
  private submissionFilterState = {
    revision: 'submission-filters-1',
    filterCollected: false,
  };
  async saveSubmissionFilters(
    filterCollected: boolean,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (revision !== this.submissionFilterState.revision)
      throw new AdminRequestError(409);
    this.submissionFilterState = {
      revision:
        'submission-filters-' + (Number(revision.split('-').at(-1)) + 1),
      filterCollected,
    };
    return { ...this.submissionFilterState };
  }
  private schedulingState: SchedulingState = {
    revision: 'schedules-1',
    enabled: false,
    schedules: [],
    permanentlyOpenPageIds: [],
  };
  async scheduling(signal: AbortSignal) {
    this.access(signal);
    return structuredClone(this.schedulingState);
  }
  private checkScheduleRevision(revision: string, signal: AbortSignal) {
    this.access(signal);
    if (revision !== this.schedulingState.revision)
      throw new AdminRequestError(409);
  }
  private nextScheduleRevision() {
    this.schedulingState.revision =
      'schedules-' +
      (Number(this.schedulingState.revision.split('-').at(-1)) + 1);
  }
  async setSchedulingEnabled(
    enabled: boolean,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkScheduleRevision(revision, signal);
    this.schedulingState.enabled = enabled;
    this.nextScheduleRevision();
    return this.scheduling(signal);
  }
  async setPermanentPages(
    pageIds: string[],
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkScheduleRevision(revision, signal);
    const ids = parsePermanentPageIds(pageIds);
    if (ids.some((id) => !this.data.pages.some((p) => p.id === id)))
      throw new AdminRequestError(422);
    this.schedulingState.permanentlyOpenPageIds = ids;
    this.nextScheduleRevision();
    return this.scheduling(signal);
  }
  async saveSchedule(
    input: CollectionScheduleInput,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
    id?: string,
  ) {
    this.checkScheduleRevision(revision, signal);
    const fields = parseCollectionScheduleInput(input);
    if (fields.pageIds.some((id) => !this.data.pages.some((p) => p.id === id)))
      throw new AdminRequestError(422);
    if (id && !this.schedulingState.schedules.some((s) => s.id === id))
      throw new AdminRequestError(404);
    if (!id && this.schedulingState.schedules.length >= 500)
      throw new AdminRequestError(422);
    const schedule = { id: id ?? crypto.randomUUID(), ...fields };
    this.schedulingState.schedules = [
      ...this.schedulingState.schedules.filter((s) => s.id !== schedule.id),
      schedule,
    ].sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
    );
    this.nextScheduleRevision();
    return this.scheduling(signal);
  }
  async deleteSchedule(
    id: string,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkScheduleRevision(revision, signal);
    if (!this.schedulingState.schedules.some((s) => s.id === id))
      throw new AdminRequestError(404);
    this.schedulingState.schedules = this.schedulingState.schedules.filter(
      (s) => s.id !== id,
    );
    this.nextScheduleRevision();
    return this.scheduling(signal);
  }
  private runelite: RuneLiteSettings = {
    revision: 'runelite-1',
    ...defaultRuneLiteRules('Clan name'),
  };
  async runeLiteSettings(signal: AbortSignal) {
    this.access(signal);
    return structuredClone(this.runelite);
  }
  async saveRuneLiteSettings(
    fields: RuneLiteSettingsUpdate,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const { expectedRevision, clanKeyRequirement, ...rules } = fields;
    if (expectedRevision !== this.runelite.revision)
      throw new AdminRequestError(409);
    const parsed = parseRuneLiteRules(rules);
    if (clanKeyRequirement) {
      if (clanKeyRequirement.expectedRevision !== this.keySettings.revision)
        throw new AdminRequestError(409);
      if (!parsed.matchClanName && !clanKeyRequirement.enabled)
        throw new AdminRequestError(422);
      this.keySettings = {
        ...this.keySettings,
        enabled: clanKeyRequirement.enabled,
        revision:
          'clan-key-' +
          (Number(this.keySettings.revision.split('-').at(-1)) + 1),
      };
    }
    this.runelite = {
      revision: 'runelite-' + (Number(expectedRevision.split('-').at(-1)) + 1),
      ...parsed,
    };
    return {
      ...(await this.runeLiteSettings(signal)),
      ...(clanKeyRequirement
        ? {
            clanKeyRequirement: {
              enabled: this.keySettings.enabled,
              revision: this.keySettings.revision,
            },
          }
        : {}),
    };
  }
  private logoSettings: Branding = { ...defaultBranding };
  private hardcoreLogoSettings: Branding = { ...defaultBranding };
  publicBranding(hardcore = false) {
    return { ...(hardcore ? this.hardcoreLogoSettings : this.logoSettings) };
  }
  async branding(signal: AbortSignal, hardcore = false) {
    this.access(signal);
    return this.publicBranding(hardcore);
  }
  async saveLogo(
    file: File | null,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
    hardcore = false,
  ) {
    this.access(signal);
    if (revision !== this.publicBranding(hardcore).revision)
      throw new AdminRequestError(409);
    if (file) throw new Error('Use the HTTP asset fixture for uploads.');
    const paths = defaultBranding;
    // Recheck after asynchronous image decoding to preserve the same concurrency contract.
    if (revision !== this.publicBranding(hardcore).revision)
      throw new AdminRequestError(409);
    const saved = {
      ...paths,
      revision: 'branding-' + (Number(revision.slice(9)) + 1),
    };
    if (hardcore) this.hardcoreLogoSettings = saved;
    else this.logoSettings = saved;
    this.changed(false);
    return this.publicBranding(hardcore);
  }
  private keySettings: ClanKeySettings = {
    revision: 'clan-key-1',
    enabled: true,
    key: generateFixtureKey(),
  };
  private revision = 0;
  private queueRevision = 0;
  private setting = {
    howToSubmitMarkdown: defaultSubmissionHelp,
    copy: { ...defaultSiteCopy },
    hardcore: { clanName: 'Clan name', copy: { ...defaultSiteCopy } },
    revision: 'settings-0',
    hardcoreEnabled: false,
    clanName: 'Clan name',
  };
  private settingsVersion = 0;
  private signedIn = true;
  private username = 'test-admin';
  private staff: StaffAccount[] = [
    {
      id: 'test-admin',
      username: 'test-admin',
      role: 'admin',
      mustChangePassword: false,
    },
  ];
  private pageVersions = new Map(
    fixtureCatalog.pages.map((page) => [page.id, 1]),
  );
  private data: AdminCatalog = {
    ...structuredClone(fixtureCatalog),
    sections: [...catalogSections(fixtureCatalog)],
    sourceRevision: 'wiki-15356324 (review sample)',
    items: fixtureCatalog.items.map((item) => ({
      ...item,
      origin: 'source',
      overrides: [],
      gameItemIds: [item.id],
    })),
    pages: fixtureCatalog.pages.map((page) => ({
      ...page,
      itemIds: [...page.itemIds],
      version: 'page-1',
      orderOrigin: 'source',
    })),
  };
  private rows: Submission[];
  private nextItemId =
    Math.max(0, ...fixtureCatalog.items.map((item) => item.id)) + 1;
  private audit = new Map<string, AuditEntry[]>();
  private assets = new Map<string, StagedIcon>();
  private receipts = new Map<string, { fields: string; result: CreatedItem }>();
  constructor() {
    const mask = fixtureCatalog.items.find(
      (item) => item.name === 'Virtus mask',
    )!.id;
    this.rows = [
      {
        id: 'sample-hardcore',
        itemId: mask,
        rawItemText: 'Virtus mask',
        collectorName: 'KihiraVD',
        hardcore: true,
        status: 'pending',
      },
      {
        id: 'sample-ordinary',
        itemId: mask,
        rawItemText: 'Virtus mask',
        collectorName: 'Oakheart',
        hardcore: false,
        status: 'pending',
      },
      {
        id: 'sample-unmatched',
        itemId: null,
        rawItemText: 'new weapon drop',
        collectorName: 'Iron Fern',
        hardcore: false,
        status: 'pending',
      },
      {
        id: 'sample-scroll',
        itemId: null,
        rawItemText: 'scroll thing',
        collectorName: 'New recruit',
        hardcore: false,
        status: 'pending',
      },
      {
        id: 'sample-rejected',
        itemId: mask,
        rawItemText: 'Virtus mask',
        collectorName: 'Example rejected',
        hardcore: true,
        status: 'rejected',
      },
      {
        id: 'sample-revoked',
        itemId: mask,
        rawItemText: 'Virtus mask',
        collectorName: 'Example revoked',
        hardcore: true,
        status: 'revoked',
      },
    ].map((row) => ({
      ...row,
      status: row.status as Submission['status'],
      version: 1,
      source: 'discord',
      collectedOn: '2026-10-05',
      dateSource: 'submission',
      submittedAt: '2026-10-05T12:00:00Z',
      proofUrl: '',
      screenshotPath:
        '/api/v1/admin/submission-images/00000000-0000-4000-8000-000000000001.webp',
      reviewNote: '',
      reviewReason: null,
    }));
  }
  private changed(includeQueue = true) {
    this.revision++;
    if (includeQueue) this.queueRevision++;
  }
  private access(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!this.signedIn) throw new AdminRequestError(401);
  }
  async login(
    _username: string,
    _password: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    this.signedIn = true;
    this.changed(false);
  }
  private manualReceipts = new Map<
    string,
    { payload: string; response: Submission }
  >();
  async addManual(
    fields: ManualSubmissionInput,
    key: string,
    _csrf: string,
    signal: AbortSignal,
    screenshot?: File,
  ) {
    this.access(signal);
    const bytes = screenshot
      ? new Uint8Array(await screenshot.arrayBuffer())
      : undefined;
    if (
      screenshot &&
      (screenshot.type !== 'image/png' ||
        screenshot.size > 10 * 1024 * 1024 ||
        bytes?.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10')
    )
      throw new AdminRequestError(
        400,
        'Choose a valid PNG screenshot up to 10 MiB.',
      );
    const payload = JSON.stringify([fields, bytes ? Array.from(bytes) : null]);
    const prior = this.manualReceipts.get(key);
    if (prior) {
      if (prior.payload !== payload) throw new AdminRequestError(409);
      return structuredClone(prior.response);
    }
    const item = this.data.items.find((row) => row.id === fields.itemId);
    if (!item) throw new AdminRequestError(422);
    const collectionType = fields.collectionType ?? 'regular';
    if (fields.hardcore && collectionType === 'event')
      throw new AdminRequestError(422);
    if (fields.approve)
      this.ensureUnique('', item.id, fields.hardcore, collectionType);
    if (fields.proofUrl !== undefined && fields.proofUrl !== '')
      throw new AdminRequestError(422);
    const id = crypto.randomUUID();
    const row: Submission = {
      id,
      ...(screenshot
        ? { screenshotPath: `/api/v1/admin/submission-images/${id}.webp` }
        : {}),
      version: 1,
      source: 'manual',
      collectionType,
      collectionReason: 'manual',
      itemId: item.id,
      rawItemText: item.name,
      collectorName: fields.collectorName.trim(),
      collectedOn: fields.collectedOn,
      dateSource: 'admin',
      submittedAt: new Date().toISOString(),
      proofUrl: fields.proofUrl ?? '',
      hardcore: fields.hardcore,
      status: fields.approve ? 'approved' : 'pending',
      reviewNote: '',
      reviewReason: fields.approve ? fields.reason?.trim() || null : null,
    };
    this.rows.unshift(row);
    this.record(row, row, 'create', fields.reason ?? '');
    this.manualReceipts.set(key, { payload, response: structuredClone(row) });
    return structuredClone(row);
  }
  async session(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return this.signedIn
      ? {
          csrfToken: 'test-admin',
          displayName: 'Test admin',
          username: this.username,
          role: 'admin' as const,
          mustChangePassword: false,
        }
      : null;
  }
  async accounts(signal: AbortSignal) {
    this.access(signal);
    return structuredClone(this.staff);
  }
  async manageModerator(
    id: string,
    expectedVersion: number,
    action: 'disable' | 'enable' | 'delete',
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const account = this.staff.find((row) => row.id === id);
    if (!account) throw new AdminRequestError(404);
    if (account.role !== 'moderator') throw new AdminRequestError(403);
    if ((account.version ?? 1) !== expectedVersion)
      throw new AdminRequestError(409);
    const saved = {
      ...account,
      disabled: action !== 'enable',
      version: expectedVersion + 1,
    };
    this.staff =
      action === 'delete'
        ? this.staff.filter((row) => row.id !== id)
        : this.staff.map((row) => (row.id === id ? saved : row));
    return saved;
  }
  private pageRequests = new Map<
    string,
    { payload: string; page: AdminPage }
  >();
  async createPage(
    fields: CreatePage,
    key: string,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const payload = JSON.stringify(fields),
      prior = this.pageRequests.get(key);
    if (prior) {
      if (prior.payload !== payload) throw new AdminRequestError(409);
      return structuredClone(prior.page);
    }
    if (revision !== this.data.revision) throw new AdminRequestError(409);
    if (
      !fields.name.trim() ||
      this.data.pages.some(
        (p) =>
          p.category === fields.category &&
          p.name.toLowerCase() === fields.name.trim().toLowerCase(),
      )
    )
      throw new AdminRequestError(400);
    if (
      new Set(fields.itemIds).size !== fields.itemIds.length ||
      fields.itemIds.some(
        (id) => !this.data.items.some((item) => item.id === id),
      )
    )
      throw new AdminRequestError(400);
    const page: AdminPage = {
      id: 'manual-page-' + crypto.randomUUID(),
      name: fields.name.trim(),
      category: fields.category,
      itemIds: [...fields.itemIds],
      version: 'page-1',
      orderOrigin: 'manual',
    };
    this.data.pages.push(page);
    this.pageVersions.set(page.id, 1);
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
    this.pageRequests.set(key, { payload, page: structuredClone(page) });
    return structuredClone(page);
  }
  async removePage(
    id: string,
    revision: string,
    version: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (revision !== this.data.revision) throw new AdminRequestError(409);
    const page = this.data.pages.find((p) => p.id === id);
    if (!page || page.version !== version) throw new AdminRequestError(409);
    if (this.schedulingState.permanentlyOpenPageIds.includes(id)) {
      this.schedulingState.permanentlyOpenPageIds =
        this.schedulingState.permanentlyOpenPageIds.filter(
          (value) => value !== id,
        );
      this.nextScheduleRevision();
    }
    this.data.pages = this.data.pages.filter((p) => p.id !== id);
    const retiredItemIds: number[] = [];
    this.pageVersions.delete(id);
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
    return { retiredItemIds };
  }
  async reorderPages(
    category: import('../../src/model.ts').Category,
    ids: string[],
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (revision !== this.data.revision) throw new AdminRequestError(409);
    const pages = this.data.pages.filter((p) => p.category === category);
    if (
      pages.length !== ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !pages.some((p) => p.id === id))
    )
      throw new AdminRequestError(400);
    let slot = 0;
    this.data.pages = this.data.pages.map((p) => {
      if (p.category !== category) return p;
      const id = ids[slot++]!;
      const page = pages.find((p) => p.id === id)!,
        version = (this.pageVersions.get(page.id) ?? 1) + 1;
      this.pageVersions.set(page.id, version);
      return { ...page, version: 'page-' + version };
    });
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
  }
  async removePageItem(
    pageId: string,
    id: number,
    revision: string,
    expectedVersion: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (revision !== this.data.revision) throw new AdminRequestError(409);
    const page = this.data.pages.find((row) => row.id === pageId);
    if (!page || !page.itemIds.includes(id)) throw new AdminRequestError(404);
    if (page.version !== expectedVersion) throw new AdminRequestError(409);
    page.itemIds = page.itemIds.filter((itemId) => itemId !== id);
    const version = this.pageVersions.get(page.id)! + 1;
    this.pageVersions.set(page.id, version);
    page.version = 'page-' + version;
    page.orderOrigin = 'manual';
    const retired = false;
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
    return { retired };
  }
  async createModerator(
    username: string,
    _password: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (
      this.staff.some(
        (account) => account.username.toLowerCase() === username.toLowerCase(),
      )
    )
      throw new AdminRequestError(409, 'That username is already in use.');
    const account: StaffAccount = {
      id: crypto.randomUUID(),
      username,
      role: 'moderator',
      mustChangePassword: true,
    };
    this.staff.push(account);
    return structuredClone(account);
  }
  async updateAccount(
    fields: { username: string; currentPassword: string; newPassword?: string },
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (
      this.staff.some(
        (account) =>
          account.id !== 'test-admin' &&
          account.username.toLowerCase() === fields.username.toLowerCase(),
      )
    )
      throw new AdminRequestError(409, 'That username is already in use.');
    this.username = fields.username;
    this.staff[0]!.username = fields.username;
    return (await this.session(signal))!;
  }
  publicSettings() {
    return { ...this.setting };
  }
  async clanApiKey(signal: AbortSignal) {
    this.access(signal);
    return { ...this.keySettings };
  }
  async saveClanApiKey(
    fields: ClanKeyUpdate,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    if (fields.expectedRevision !== this.keySettings.revision)
      throw new AdminRequestError(409);
    if (
      (fields.key !== undefined && !validClanKey(fields.key)) ||
      (fields.key !== undefined && fields.generate) ||
      (fields.enabled === undefined &&
        fields.key === undefined &&
        fields.generate !== true)
    )
      throw new AdminRequestError(422);
    this.keySettings = {
      revision:
        'clan-key-' + (Number(this.keySettings.revision.split('-').at(-1)) + 1),
      enabled: fields.enabled ?? this.keySettings.enabled,
      key: fields.generate
        ? generateFixtureKey()
        : (fields.key ?? this.keySettings.key),
    };
    return { ...this.keySettings };
  }
  async settings(signal: AbortSignal) {
    this.access(signal);
    return this.publicSettings();
  }
  async saveSettings(
    hardcoreEnabled: boolean,
    expectedRevision: string,
    _csrf: string,
    signal: AbortSignal,
    clanName?: string,
    copy?: SiteCopy,
    hardcore?: HardcoreAppearance,
    howToSubmitMarkdown?: string,
  ) {
    this.access(signal);
    if (expectedRevision !== this.setting.revision)
      throw new AdminRequestError(409);
    this.setting = {
      howToSubmitMarkdown:
        howToSubmitMarkdown === undefined
          ? this.setting.howToSubmitMarkdown
          : parseSubmissionHelp(howToSubmitMarkdown),
      copy: copy ? parseSiteCopy(copy) : this.setting.copy,
      hardcore: hardcore
        ? parseHardcoreAppearance(hardcore)
        : this.setting.hardcore,
      hardcoreEnabled,
      clanName: clanName?.trim() ?? this.setting.clanName,
      revision: 'settings-' + ++this.settingsVersion,
    };
    this.changed(false);
    return this.publicSettings();
  }
  private ensureUnique(
    id: string,
    itemId: number,
    hardcore: boolean,
    type: 'regular' | 'event' = 'regular',
  ) {
    if (type === 'regular' && !this.submissionFilterState.filterCollected)
      return;
    if (
      this.rows.some(
        (row) =>
          row.id !== id &&
          row.status === 'approved' &&
          row.itemId === itemId &&
          row.hardcore === hardcore &&
          (row.collectionType ?? 'regular') === type,
      )
    )
      throw new AdminRequestError(
        409,
        type === 'event'
          ? 'An approved Event collection already exists for this item. Revoke it before approving another Event collection.'
          : 'Filter out regular duplicates is on and this item already has a Regular collection in this world mode.',
      );
  }
  async logout(_csrf: string, signal: AbortSignal) {
    this.access(signal);
    this.signedIn = false;
  }
  async catalog(signal: AbortSignal) {
    this.access(signal);
    return structuredClone({
      ...this.data,
      collectedItemIds: this.rows
        .filter(
          (row) =>
            row.status === 'approved' && !row.hardcore && row.itemId !== null,
        )
        .map((row) => row.itemId!),
    });
  }
  private checkCatalog(revision: string, signal: AbortSignal) {
    this.access(signal);
    if (revision !== this.data.revision) throw new AdminRequestError(409);
  }
  private catalogChanged() {
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
  }
  private sectionRequests = new Map<
    string,
    { name: string; section: { id: string; name: string } }
  >();
  async createSection(
    name: string,
    key: string,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const prior = this.sectionRequests.get(key);
    if (prior) {
      if (prior.name !== name) throw new AdminRequestError(409);
      return structuredClone(prior.section);
    }
    this.checkCatalog(revision, signal);
    if (
      this.data.sections!.some(
        (s) => s.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new AdminRequestError(400);
    const section = { id: 'section-' + crypto.randomUUID(), name };
    this.data.sections!.push(section);
    this.catalogChanged();
    this.sectionRequests.set(key, { name, section });
    return { ...section };
  }
  async editSection(
    id: string,
    name: string | null,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    const section = this.data.sections!.find((s) => s.id === id);
    if (!section) throw new AdminRequestError(404);
    if (name === null) {
      if (this.data.pages.some((p) => p.category === id))
        throw new AdminRequestError(409);
      this.data.sections = this.data.sections!.filter((s) => s.id !== id);
    } else {
      if (
        this.data.sections!.some(
          (s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw new AdminRequestError(400);
      section.name = name;
    }
    this.catalogChanged();
  }
  async reorderSections(
    ids: string[],
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    const sections = this.data.sections!;
    if (
      ids.length !== sections.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !sections.some((s) => s.id === id))
    )
      throw new AdminRequestError(400);
    this.data.sections = ids.map((id) => sections.find((s) => s.id === id)!);
    this.catalogChanged();
  }
  async renamePage(
    id: string,
    name: string,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    const page = this.data.pages.find((p) => p.id === id);
    if (!page) throw new AdminRequestError(404);
    if (
      this.data.pages.some(
        (p) =>
          p.id !== id &&
          p.category === page.category &&
          p.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new AdminRequestError(400);
    page.name = name;
    this.catalogChanged();
  }
  async attachItem(
    pageId: string,
    id: number,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    const page = this.data.pages.find((p) => p.id === pageId);
    if (!page || !this.data.items.some((item) => item.id === id))
      throw new AdminRequestError(404);
    if (!page.itemIds.includes(id)) {
      page.itemIds.push(id);
      page.version = 'page-' + ((this.pageVersions.get(pageId) ?? 1) + 1);
      this.pageVersions.set(pageId, Number(page.version.slice(5)));
      this.catalogChanged();
    }
  }
  async editItem(
    id: number,
    fields: { name: string; gameItemIds: number[]; iconAssetId?: string },
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    const item = this.data.items.find((i) => i.id === id),
      asset = fields.iconAssetId
        ? this.assets.get(fields.iconAssetId)
        : undefined;
    if (!item) throw new AdminRequestError(404);
    if (
      this.data.items.some(
        (i) =>
          i.id !== id &&
          i.gameItemIds?.some((game) => fields.gameItemIds.includes(game)),
      )
    )
      throw new AdminRequestError(409);
    if (fields.iconAssetId && !asset) throw new AdminRequestError(422);
    item.name = fields.name;
    item.gameItemIds = [...fields.gameItemIds];
    if (asset) item.iconPath = asset.iconPath;
    this.catalogChanged();
  }
  async deleteItem(
    id: number,
    revision: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.checkCatalog(revision, signal);
    if (!this.data.items.some((item) => item.id === id))
      throw new AdminRequestError(404);
    this.data.items = this.data.items.filter((item) => item.id !== id);
    for (const page of this.data.pages.filter((p) => p.itemIds.includes(id))) {
      page.itemIds = page.itemIds.filter((item) => item !== id);
      const version = (this.pageVersions.get(page.id) ?? 1) + 1;
      this.pageVersions.set(page.id, version);
      page.version = 'page-' + version;
    }
    this.catalogChanged();
  }
  /** Project only public catalog fields and approved credits, excluding private review data. */
  publicLog(scenario: Scenario | 'reviewed' = 'reviewed'): LogData {
    return structuredClone({
      catalog: {
        revision: this.data.revision,
        sections: this.data.sections!,
        items: this.data.items.map(({ id, name, iconPath }) => ({
          id,
          name,
          iconPath,
        })),
        pages: this.data.pages.map(({ id, name, category, itemIds }) => ({
          id,
          name,
          category,
          itemIds,
        })),
      },
      collections:
        scenario === 'reviewed'
          ? {
              revision: 'test-credits-' + this.revision,
              credits: this.rows
                .filter(
                  (row) =>
                    row.status === 'approved' &&
                    this.data.items.some((item) => item.id === row.itemId),
                )
                .map((row) => ({
                  submissionId: row.id,
                  itemId: row.itemId!,
                  collectorName: row.collectorName,
                  collectedOn: row.collectedOn,
                  hardcore: row.hardcore,
                  collectionType: row.collectionType ?? 'regular',
                  status: 'approved',
                })),
            }
          : fixtureCollections(scenario),
    });
  }
  async queue(
    view: QueueView,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    this.access(signal);
    // Revision-bound cursors reject pagination through a ledger changed by another action.
    const match = cursor
      ? /^(\d+):(\d+):(pending|unmatched|reviewed)$/u.exec(cursor)
      : undefined;
    if (
      cursor &&
      (!match || Number(match[2]) !== this.queueRevision || match[3] !== view)
    )
      throw new AdminRequestError(409);
    const start = match ? Number(match[1]) : 0;
    const rows = this.rows.filter((row) =>
      view === 'reviewed'
        ? row.status !== 'pending'
        : row.status === 'pending' &&
          (view !== 'unmatched' || row.itemId === null),
    );
    return structuredClone({
      revision: 'test-queue-' + this.queueRevision,
      filters: this.submissionFilterState,
      pageCursor: start + ':' + this.queueRevision + ':' + view,
      submissions: rows.slice(start, start + 2),
      nextCursor:
        start + 2 < rows.length
          ? String(start + 2) + ':' + this.queueRevision + ':' + view
          : null,
    });
  }
  private row(id: string, version?: number) {
    const row = this.rows.find((s) => s.id === id);
    if (!row) throw new AdminRequestError(404);
    if (version !== undefined && row.version !== version)
      throw new AdminRequestError(409);
    return row;
  }
  async detail(id: string, signal: AbortSignal, cursor?: string) {
    this.access(signal);
    const row = this.row(id);
    const revision = 'test-audit-' + this.queueRevision + '-' + id;
    let start = 0;
    if (cursor) {
      const match = /^(\d+):(.*)$/u.exec(cursor);
      if (
        !match ||
        match[2] !== revision ||
        !Number.isSafeInteger(Number(match[1]))
      )
        throw new AdminRequestError(409);
      start = Number(match[1]);
    }
    const events = this.audit.get(id) ?? [];
    return structuredClone({
      submission: row,
      audit: events.slice(start, start + 20),
      auditRevision: revision,
      auditCursor: start + ':' + revision,
      nextAuditCursor:
        start + 20 < events.length ? start + 20 + ':' + revision : null,
    });
  }
  /** Copy snapshots before notifying subscribers so later edits cannot rewrite audit history. */
  private record(
    before: Submission,
    after: Submission,
    action: AuditEntry['action'],
    reason: string,
  ) {
    const events = this.audit.get(before.id) ?? [];
    events.unshift({
      id: crypto.randomUUID(),
      actorName: 'Test admin',
      at: new Date().toISOString(),
      action,
      reason: reason || null,
      before: structuredClone(before),
      after: structuredClone(after),
    });
    this.audit.set(before.id, events);
    this.changed();
  }
  async saveReviewNote(
    id: string,
    version: number,
    note: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const row = this.row(id, version);
    if (
      !['pending', 'approved'].includes(row.status) ||
      typeof note !== 'string' ||
      note.trim().length > 1000 ||
      note.trim() === row.reviewNote
    )
      throw new AdminRequestError(422);
    const before = structuredClone(row);
    row.reviewNote = note.trim();
    row.version++;
    this.record(before, row, 'edit', '');
    return structuredClone(row);
  }
  async edit(
    id: string,
    version: number,
    fields: Correction,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const row = this.row(id, version),
      clean = validateCorrection(fields, this.data);
    if (
      !['pending', 'approved'].includes(row.status) ||
      (row.status === 'approved' && !clean.reason)
    )
      throw new AdminRequestError(422);
    const collectionType = clean.hardcore
      ? 'regular'
      : (clean.collectionType ?? row.collectionType ?? 'regular');
    if (
      row.status === 'approved' &&
      (row.itemId !== clean.itemId ||
        row.hardcore !== clean.hardcore ||
        (row.collectionType ?? 'regular') !== collectionType)
    )
      this.ensureUnique(id, clean.itemId, clean.hardcore, collectionType);
    const before = structuredClone(row);
    Object.assign(row, {
      itemId: clean.itemId,
      collectorName: clean.collectorName,
      collectedOn: clean.collectedOn,
      hardcore: clean.hardcore,
      collectionType,
      collectionReason:
        clean.collectionType === undefined
          ? (row.collectionReason ?? 'legacy')
          : 'staff_correction',
      dateSource:
        clean.collectedOn === before.collectedOn ? before.dateSource : 'admin',
      version: version + 1,
      reviewReason: row.status === 'approved' ? clean.reason : row.reviewReason,
    });
    this.record(before, row, 'edit', clean.reason);
    return structuredClone(row);
  }
  async decide(
    id: string,
    version: number,
    action: 'approve' | 'reject' | 'revoke',
    reason: string,
    _csrf: string,
    signal: AbortSignal,
    flags?: CollectionFlags,
  ) {
    this.access(signal);
    const row = this.row(id, version);
    if (action === 'revoke' && flags) throw new AdminRequestError(422);
    const selected = flags ? this.selectedFlags(row, flags) : row;
    if (
      (action === 'revoke'
        ? row.status !== 'approved'
        : row.status !== 'pending') ||
      (action === 'approve'
        ? !this.data.items.some((item) => item.id === row.itemId) ||
          (row.source !== 'manual' &&
            !safeScreenshotPath(row.screenshotPath) &&
            !(row.source === 'runelite' && row.chatMessage?.trim()))
        : !reason.trim())
    )
      throw new AdminRequestError(422);
    if (action === 'approve')
      this.ensureUnique(
        id,
        row.itemId!,
        selected.hardcore,
        selected.collectionType ?? 'regular',
      );
    const before = structuredClone(row);
    if (flags) Object.assign(row, selected);
    row.status = (
      { approve: 'approved', reject: 'rejected', revoke: 'revoked' } as const
    )[action];
    row.version++;
    row.reviewReason = action === 'approve' ? null : reason.trim();
    this.record(before, row, action, reason.trim());
    return structuredClone(row);
  }
  private selectedFlags(row: Submission, flags: CollectionFlags) {
    if (
      (flags.useIntakeTiming && row.source === 'manual') ||
      (flags.hardcore && flags.collectionType === 'event')
    )
      throw new AdminRequestError(422);
    return {
      hardcore: flags.hardcore,
      collectionType: flags.hardcore
        ? ('regular' as const)
        : (flags.collectionType ?? row.collectionType ?? ('regular' as const)),
      collectionReason: flags.useIntakeTiming
        ? 'scheduling_disabled'
        : 'staff_correction',
    };
  }
  async saveCollectionFlags(
    id: string,
    version: number,
    flags: CollectionFlags,
    reason: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const row = this.row(id, version);
    if (row.status !== 'approved' || !reason.trim())
      throw new AdminRequestError(422);
    const selected = this.selectedFlags(row, flags);
    this.ensureUnique(
      id,
      row.itemId!,
      selected.hardcore,
      selected.collectionType,
    );
    const before = structuredClone(row);
    Object.assign(row, selected, {
      version: version + 1,
      reviewReason: reason.trim(),
    });
    this.record(before, row, 'edit', reason.trim());
    return structuredClone(row);
  }
  async upload(
    file: File,
    _csrf: string,
    signal: AbortSignal,
    iconPath?: string,
  ) {
    this.access(signal);
    await validateIconFile(file);
    this.access(signal);
    const icon = {
      assetId: crypto.randomUUID(),
      iconPath: iconPath ?? URL.createObjectURL(file),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };
    this.assets.set(icon.assetId, icon);
    return { ...icon };
  }
  async create(
    fields: CreateItem,
    key: string,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    // Matching retries return the receipt; reusing a key for different fields is a conflict.
    const clean = validateItem(fields, this.data),
      serialized = JSON.stringify(clean),
      receipt = this.receipts.get(key);
    if (receipt) {
      if (receipt.fields !== serialized) throw new AdminRequestError(409);
      return structuredClone(receipt.result);
    }
    const asset = this.assets.get(clean.iconAssetId);
    if (
      this.data.items.some((item) =>
        item.gameItemIds?.some((id) => clean.gameItemIds.includes(id)),
      )
    )
      throw new AdminRequestError(409);
    if (!asset || Date.parse(asset.expiresAt) <= Date.now())
      throw new AdminRequestError(422);
    // This allocator is safe only in this single in-memory simulator, not a concurrent API.
    const item = {
      id: this.nextItemId++,
      name: clean.name,
      gameItemIds: [...clean.gameItemIds],
      iconPath: asset.iconPath,
      origin: 'manual' as const,
      overrides: ['name', 'icon', 'pages'] as const,
    };
    const created = { ...item, overrides: [...item.overrides] };
    this.data.items.push(created);
    for (const page of this.data.pages.filter((page) =>
      clean.pageIds.includes(page.id),
    )) {
      page.itemIds.push(item.id);
      const version = this.pageVersions.get(page.id)! + 1;
      this.pageVersions.set(page.id, version);
      page.version = 'page-' + version;
    }
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
    const result = {
      item: created,
      pageIds: [...clean.pageIds],
      catalogRevision: this.data.revision,
    };
    this.receipts.set(key, { fields: serialized, result });
    return structuredClone(result);
  }
  async order(
    pageId: string,
    ids: number[],
    version: string,
    _csrf: string,
    signal: AbortSignal,
  ): Promise<AdminPage> {
    this.access(signal);
    const page = this.data.pages.find((page) => page.id === pageId);
    if (!page) throw new AdminRequestError(404);
    if (page.version !== version) throw new AdminRequestError(409);
    validateOrder(page.itemIds, ids);
    page.itemIds = [...ids];
    page.orderOrigin = 'manual';
    const next = this.pageVersions.get(pageId)! + 1;
    this.pageVersions.set(pageId, next);
    page.version = 'page-' + next;
    this.changed();
    this.data.revision = 'test-catalog-' + this.revision;
    return structuredClone(page);
  }
  /** Release test-owned blob assets after a fixture finishes. */
  dispose() {
    for (const asset of this.assets.values())
      URL.revokeObjectURL(asset.iconPath);
    this.assets.clear();
  }
}

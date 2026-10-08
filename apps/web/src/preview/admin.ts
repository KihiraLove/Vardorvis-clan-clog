/** In-memory admin simulator shared with the public preview; all state is lost on reload. */
import { AdminRequestError } from '../admin-api.ts';
import {
  safeProof,
  validateCorrection,
  validateIconFile,
  validateItem,
  validateOrder,
  type AdminCatalog,
  type AdminClient,
  type AdminPage,
  type AuditEntry,
  type Correction,
  type ManualSubmissionInput,
  type CreatedItem,
  type CreateItem,
  type QueueView,
  type StagedIcon,
  type Submission,
} from '../admin-model.ts';
import type { LogData } from '../model.ts';
import {
  previewCatalog,
  previewCollections,
  type Scenario,
} from './scenarios.ts';

export class PreviewAdminClient implements AdminClient {
  private revision = 0;
  private queueRevision = 0;
  private setting = { revision: 'settings-0', hardcoreEnabled: false };
  private settingsVersion = 0;
  private signedIn = true;
  private listeners = new Set<() => void>();
  private pageVersions = new Map(
    previewCatalog.pages.map((page) => [page.id, 1]),
  );
  private data: AdminCatalog = {
    ...structuredClone(previewCatalog),
    sourceRevision: 'wiki-15356324 (review sample)',
    items: previewCatalog.items.map((item) => ({
      ...item,
      origin: 'source',
      overrides: [],
    })),
    pages: previewCatalog.pages.map((page) => ({
      ...page,
      itemIds: [...page.itemIds],
      version: 'page-1',
      orderOrigin: 'source',
    })),
  };
  private rows: Submission[];
  private audit = new Map<string, AuditEntry[]>();
  private assets = new Map<string, StagedIcon>();
  private receipts = new Map<string, { fields: string; result: CreatedItem }>();
  constructor() {
    const mask = previewCatalog.items.find(
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
      proofUrl: 'https://imgur.com/a/preview-proof',
    }));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getRevision = () => this.revision;
  private changed(includeQueue = true) {
    this.revision++;
    if (includeQueue) this.queueRevision++;
    for (const listener of this.listeners) listener();
  }
  private access(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!this.signedIn) throw new AdminRequestError(401);
  }
  async login(_password: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    this.signedIn = true;
    this.changed(false);
  }
  async addManual(
    fields: ManualSubmissionInput,
    _csrf: string,
    signal: AbortSignal,
  ) {
    this.access(signal);
    const item = this.data.items.find((row) => row.id === fields.itemId);
    if (!item) throw new AdminRequestError(422);
    if (fields.approve) this.ensureUnique('', item.id, fields.hardcore);
    if (fields.proofUrl && !safeProof(fields.proofUrl))
      throw new AdminRequestError(422);
    const row: Submission = {
      id: crypto.randomUUID(),
      version: 1,
      source: 'manual',
      itemId: item.id,
      rawItemText: item.name,
      collectorName: fields.collectorName.trim(),
      collectedOn: fields.collectedOn,
      dateSource: 'admin',
      submittedAt: new Date().toISOString(),
      proofUrl: fields.proofUrl ?? '',
      hardcore: fields.hardcore,
      status: fields.approve ? 'approved' : 'pending',
    };
    this.rows.unshift(row);
    this.record(row, row, 'create', fields.reason ?? '');
    return structuredClone(row);
  }
  async session(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return this.signedIn
      ? { csrfToken: 'preview-admin', displayName: 'Preview admin' }
      : null;
  }
  publicSettings() {
    return { ...this.setting };
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
  ) {
    this.access(signal);
    if (expectedRevision !== this.setting.revision)
      throw new AdminRequestError(409);
    this.setting = {
      hardcoreEnabled,
      revision: 'settings-' + ++this.settingsVersion,
    };
    this.changed(false);
    return this.publicSettings();
  }
  private ensureUnique(id: string, itemId: number, hardcore: boolean) {
    if (
      this.rows.some(
        (row) =>
          row.id !== id &&
          row.status === 'approved' &&
          row.itemId === itemId &&
          row.hardcore === hardcore,
      )
    )
      throw new AdminRequestError(409);
  }
  async logout(_csrf: string, signal: AbortSignal) {
    this.access(signal);
    this.signedIn = false;
  }
  async catalog(signal: AbortSignal) {
    this.access(signal);
    return structuredClone(this.data);
  }
  /** Project only public catalog fields and approved credits, excluding private review data. */
  publicLog(scenario: Scenario | 'reviewed' = 'reviewed'): LogData {
    return structuredClone({
      catalog: {
        revision: this.data.revision,
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
              revision: 'preview-credits-' + this.revision,
              credits: this.rows
                .filter((row) => row.status === 'approved')
                .map((row) => ({
                  submissionId: row.id,
                  itemId: row.itemId!,
                  collectorName: row.collectorName,
                  collectedOn: row.collectedOn,
                  hardcore: row.hardcore,
                  status: 'approved',
                })),
            }
          : previewCollections(scenario),
    });
  }
  async queue(
    view: QueueView,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    this.access(signal);
    // Revision-bound cursors reject pagination through a ledger changed by another action.
    const match = cursor ? /^(\d+):(\d+)$/u.exec(cursor) : undefined;
    if (cursor && (!match || Number(match[2]) !== this.queueRevision))
      throw new AdminRequestError(409);
    const start = match ? Number(match[1]) : 0;
    const rows = this.rows.filter((row) =>
      view === 'reviewed'
        ? row.status !== 'pending'
        : row.status === 'pending' &&
          (view !== 'unmatched' || row.itemId === null),
    );
    return structuredClone({
      revision: 'preview-queue-' + this.queueRevision,
      submissions: rows.slice(start, start + 2),
      nextCursor:
        start + 2 < rows.length
          ? String(start + 2) + ':' + this.queueRevision
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
  async detail(id: string, signal: AbortSignal) {
    this.access(signal);
    return structuredClone({
      submission: this.row(id),
      audit: this.audit.get(id) ?? [],
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
      actorName: 'Preview admin',
      at: new Date().toISOString(),
      action,
      reason: reason || null,
      before: structuredClone(before),
      after: structuredClone(after),
    });
    this.audit.set(before.id, events);
    this.changed();
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
    if (row.status === 'approved')
      this.ensureUnique(id, clean.itemId, clean.hardcore);
    const before = structuredClone(row);
    Object.assign(row, {
      itemId: clean.itemId,
      collectorName: clean.collectorName,
      collectedOn: clean.collectedOn,
      hardcore: clean.hardcore,
      dateSource:
        clean.collectedOn === before.collectedOn ? before.dateSource : 'admin',
      version: version + 1,
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
  ) {
    this.access(signal);
    const row = this.row(id, version);
    if (
      (action === 'revoke'
        ? row.status !== 'approved'
        : row.status !== 'pending') ||
      (action === 'approve'
        ? row.itemId === null ||
          (row.source !== 'manual' && !safeProof(row.proofUrl))
        : !reason.trim())
    )
      throw new AdminRequestError(422);
    if (action === 'approve') this.ensureUnique(id, row.itemId!, row.hardcore);
    const before = structuredClone(row);
    row.status = (
      { approve: 'approved', reject: 'rejected', revoke: 'revoked' } as const
    )[action];
    row.version++;
    this.record(before, row, action, reason.trim());
    return structuredClone(row);
  }
  async upload(file: File, _csrf: string, signal: AbortSignal) {
    this.access(signal);
    await validateIconFile(file);
    this.access(signal);
    const icon = {
      assetId: crypto.randomUUID(),
      iconPath: URL.createObjectURL(file),
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
    if (!asset || Date.parse(asset.expiresAt) <= Date.now())
      throw new AdminRequestError(422);
    // This allocator is safe only in this single in-memory simulator, not a concurrent API.
    const item = {
      id: Math.max(0, ...this.data.items.map((i) => i.id)) + 1,
      name: clean.name,
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
    this.data.revision = 'preview-catalog-' + this.revision;
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
    this.data.revision = 'preview-catalog-' + this.revision;
    return structuredClone(page);
  }
  /** Blob URLs belong to this preview client and must be released when its mode is left. */
  dispose() {
    for (const asset of this.assets.values())
      URL.revokeObjectURL(asset.iconPath);
    this.assets.clear();
  }
}

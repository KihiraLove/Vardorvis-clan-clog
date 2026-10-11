/** Same-origin private HTTP adapter for future admin routes; validates mutation receipts. */
import { parseClanKey, type ClanKeyUpdate } from './clan-api-key.ts';
import { parseSettings } from './site-settings.ts';
import { parseBranding, validateLogoFile } from './branding.ts';
import { LiveXpClient } from './xp-api.ts';
import {
  list,
  object,
  text,
  timestamp,
  unique,
  parseAdminSession,
} from './xp-model.ts';
import {
  parseAdminCatalog,
  parseAdminItem,
  parseAdminPage,
  parseDetail,
  parseQueue,
  parseSubmission,
  parseStaffAccount,
  safeScreenshotPath,
  validateIconFile,
  type AdminCatalog,
  type AdminClient,
  type AdminPage,
  type Correction,
  type ManualSubmissionInput,
  type CreatedItem,
  type CreateItem,
  type QueueView,
  type StagedIcon,
} from './admin-model.ts';

export class AdminRequestError extends Error {
  readonly status: number;
  constructor(status: number, serverConflict?: string) {
    super(
      [400, 409].includes(status) &&
        serverConflict &&
        [
          'That username is already in use.',
          'The current password is incorrect.',
          'Choose a new password to finish account setup.',
          'Choose a password different from your current password.',
          'Your account changed. Sign in again before retrying.',
        ].includes(serverConflict)
        ? serverConflict
        : status === 409 &&
            serverConflict ===
              'An approved credit already exists for this item and world mode. Revoke the existing credit or select a different item or mode.'
          ? serverConflict
          : status === 401
            ? 'Your session expired. Sign in again.'
            : status === 403
              ? 'Your account is not allowed to administer the clan.'
              : status === 409
                ? 'Another change was saved. Load the latest data before trying again.'
                : status === 413
                  ? 'The uploaded image is too large.'
                  : status === 422 || status === 400
                    ? 'The server could not validate these fields. Review them before retrying.'
                    : [404, 501, 503].includes(status)
                      ? 'The admin service is not available yet.'
                      : 'The request could not be completed. Reload or retry to check the current result.',
    );
    this.status = status;
  }
}
export class LiveAdminClient implements AdminClient {
  private readonly request: typeof fetch;
  private readonly auth: LiveXpClient;
  constructor(request: typeof fetch = fetch) {
    this.request = request.bind(globalThis);
    this.auth = new LiveXpClient(request);
  }
  private async response(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
  ) {
    const response = await this.request(path, {
      ...options,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      let serverConflict: string | undefined;
      if ([400, 409].includes(response.status)) {
        try {
          const body: unknown = await response.json();
          if (
            body &&
            typeof body === 'object' &&
            'error' in body &&
            typeof body.error === 'string'
          )
            serverConflict = body.error;
        } catch {
          // Unexpected error responses keep the standard conflict message.
        }
      }
      throw new AdminRequestError(response.status, serverConflict);
    }
    return response;
  }
  private async json(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
  ) {
    return (
      await this.response(path, signal, options)
    ).json() as Promise<unknown>;
  }
  // CSRF protects browser writes; a stable request key lets creation retries be deduplicated.
  private write(
    csrf: string,
    body: unknown,
    method = 'POST',
    key?: string,
  ): RequestInit {
    return {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    };
  }
  async session(signal: AbortSignal) {
    try {
      return await this.auth.session(signal);
    } catch (failure) {
      if (
        failure instanceof Error &&
        'status' in failure &&
        typeof failure.status === 'number'
      )
        throw new AdminRequestError(failure.status);
      throw failure;
    }
  }
  async login(
    username: string,
    password: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.response('/api/v1/auth/login', signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }
  async accounts(signal: AbortSignal) {
    const result = object(await this.json('/api/v1/admin/accounts', signal));
    const accounts = list(result.accounts).map(parseStaffAccount);
    unique(accounts.map((account) => account.id));
    return accounts;
  }
  async manageModerator(
    id: string,
    expectedVersion: number,
    action: 'disable' | 'enable' | 'delete',
    csrf: string,
    signal: AbortSignal,
  ) {
    const result = parseStaffAccount(
      await this.json(
        `/api/v1/admin/accounts/${encodeURIComponent(id)}/${action}`,
        signal,
        this.write(csrf, { expectedVersion }),
      ),
    );
    if (
      result.id !== id ||
      result.role !== 'moderator' ||
      !result.version ||
      result.version <= expectedVersion ||
      result.disabled !== (action !== 'enable')
    )
      throw new Error('Unexpected moderator account receipt.');
    return result;
  }
  async removePageItem(
    pageId: string,
    id: number,
    revision: string,
    version: string,
    csrf: string,
    signal: AbortSignal,
  ) {
    const result = object(
      await this.json(
        `/api/v1/admin/catalog/pages/${encodeURIComponent(pageId)}/items/${id}`,
        signal,
        this.write(
          csrf,
          { expectedRevision: revision, expectedVersion: version },
          'DELETE',
        ),
      ),
    );
    if (
      result.itemId !== id ||
      result.pageId !== pageId ||
      typeof result.retired !== 'boolean' ||
      text(result.catalogRevision) === revision
    )
      throw new Error('Unexpected catalog deletion receipt.');
    return { retired: result.retired };
  }
  async createModerator(
    username: string,
    password: string,
    csrf: string,
    signal: AbortSignal,
  ) {
    const response = await this.response(
      '/api/v1/admin/accounts',
      signal,
      this.write(csrf, { username, password }),
    );
    if (response.status !== 201)
      throw new Error('Unexpected account creation status.');
    const account = parseStaffAccount(await response.json());
    if (
      account.username !== username ||
      account.role !== 'moderator' ||
      !account.mustChangePassword
    )
      throw new Error('Unexpected moderator account receipt.');
    return account;
  }
  async updateAccount(
    fields: { username: string; currentPassword: string; newPassword?: string },
    csrf: string,
    signal: AbortSignal,
  ) {
    const session = parseAdminSession(
      await this.json(
        '/api/v1/auth/account',
        signal,
        this.write(csrf, fields, 'PATCH'),
      ),
    );
    if (
      !session ||
      session.username !== fields.username ||
      (fields.newPassword && session.mustChangePassword)
    )
      throw new Error('Unexpected account update receipt.');
    return session;
  }
  async addManual(
    fields: ManualSubmissionInput,
    key: string,
    csrf: string,
    signal: AbortSignal,
    screenshot?: File,
  ) {
    const upload = screenshot ? new FormData() : undefined;
    if (upload && screenshot) {
      upload.append('submission', JSON.stringify(fields));
      upload.append('screenshot', screenshot);
    }
    const response = await this.response(
      upload ? '/api/v1/admin/submissions/upload' : '/api/v1/admin/submissions',
      signal,
      upload
        ? {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': key },
            body: upload,
          }
        : this.write(csrf, fields, 'POST', key),
    );
    if (response.status !== 201)
      throw new Error('Unexpected manual submission status.');
    const result = parseSubmission(await response.json());
    if (
      result.source !== 'manual' ||
      (screenshot && !safeScreenshotPath(result.screenshotPath)) ||
      result.itemId !== fields.itemId ||
      result.hardcore !== fields.hardcore ||
      result.status !== (fields.approve ? 'approved' : 'pending')
    )
      throw new Error('Unexpected manual submission receipt.');
    return result;
  }
  async clanApiKey(signal: AbortSignal) {
    return parseClanKey(await this.json('/api/v1/admin/clan-api-key', signal));
  }
  async saveClanApiKey(
    fields: ClanKeyUpdate,
    csrf: string,
    signal: AbortSignal,
  ) {
    const result = parseClanKey(
      await this.json(
        '/api/v1/admin/clan-api-key',
        signal,
        this.write(csrf, fields, 'PUT'),
      ),
    );
    if (
      result.revision === fields.expectedRevision ||
      (fields.enabled !== undefined && result.enabled !== fields.enabled) ||
      (fields.key !== undefined && result.key !== fields.key)
    )
      throw new Error('Unexpected API key receipt.');
    return result;
  }
  async settings(signal: AbortSignal) {
    return parseSettings(await this.json('/api/v1/admin/settings', signal));
  }
  async branding(signal: AbortSignal) {
    return parseBranding(await this.json('/api/v1/admin/branding', signal));
  }
  async saveLogo(
    file: File | null,
    revision: string,
    csrf: string,
    signal: AbortSignal,
  ) {
    let options: RequestInit;
    if (file) {
      validateLogoFile(file);
      const data = new FormData();
      data.set('logo', file);
      options = {
        method: 'PUT',
        headers: { 'X-CSRF-Token': csrf, 'If-Match': revision },
        body: data,
      };
    } else options = this.write(csrf, { expectedRevision: revision }, 'DELETE');
    let payload: unknown;
    try {
      payload = await this.json('/api/v1/admin/branding/logo', signal, options);
    } catch (failure) {
      if (
        file &&
        failure instanceof AdminRequestError &&
        failure.status === 400
      )
        throw new Error(
          'The logo could not be decoded. Choose a supported image within the listed limits.',
          { cause: failure },
        );
      throw failure;
    }
    const result = parseBranding(payload);
    if (result.revision === revision)
      throw new Error('Unexpected logo receipt.');
    return result;
  }
  async saveSettings(
    hardcoreEnabled: boolean,
    expectedRevision: string,
    csrf: string,
    signal: AbortSignal,
    clanName?: string,
    copy?: import('@clog/domain').SiteCopy,
  ) {
    const result = parseSettings(
      await this.json(
        '/api/v1/admin/settings',
        signal,
        this.write(
          csrf,
          {
            hardcoreEnabled,
            expectedRevision,
            ...(clanName === undefined ? {} : { clanName }),
            ...(copy === undefined ? {} : { copy }),
          },
          'PUT',
        ),
      ),
    );
    if (
      result.hardcoreEnabled !== hardcoreEnabled ||
      (clanName !== undefined && result.clanName !== clanName.trim()) ||
      (copy !== undefined &&
        JSON.stringify(result.copy) !== JSON.stringify(copy)) ||
      result.revision === expectedRevision
    )
      throw new Error('Unexpected settings receipt.');
    return result;
  }
  async logout(csrf: string, signal: AbortSignal) {
    await this.response('/api/v1/auth/logout', signal, this.write(csrf, {}));
  }
  async catalog(signal: AbortSignal): Promise<AdminCatalog> {
    return parseAdminCatalog(await this.json('/api/v1/admin/catalog', signal));
  }
  async queue(
    view: QueueView,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    const params = new URLSearchParams({
      status: view === 'reviewed' ? 'reviewed' : 'pending',
      limit: '20',
    });
    if (view === 'unmatched') params.set('unmatched', 'true');
    if (cursor) params.set('cursor', cursor);
    return parseQueue(
      await this.json('/api/v1/admin/submissions?' + params, signal),
      view,
    );
  }
  async detail(id: string, signal: AbortSignal) {
    const result = parseDetail(
      await this.json(
        '/api/v1/admin/submissions/' + encodeURIComponent(id),
        signal,
      ),
    );
    if (result.submission.id !== id)
      throw new Error('Unexpected submission identity.');
    return result;
  }
  /** Version checks are the server's concurrency contract; receipts must advance it. */
  async edit(
    id: string,
    version: number,
    fields: Correction,
    csrf: string,
    signal: AbortSignal,
  ) {
    const result = parseSubmission(
      await this.json(
        '/api/v1/admin/submissions/' + encodeURIComponent(id),
        signal,
        this.write(csrf, { ...fields, expectedVersion: version }, 'PATCH'),
      ),
    );
    if (result.id !== id || result.version <= version)
      throw new Error('Unexpected correction receipt.');
    return result;
  }
  async decide(
    id: string,
    version: number,
    action: 'approve' | 'reject' | 'revoke',
    reason: string,
    csrf: string,
    signal: AbortSignal,
  ) {
    const result = parseSubmission(
      await this.json(
        '/api/v1/admin/submissions/' + encodeURIComponent(id) + '/' + action,
        signal,
        this.write(csrf, {
          expectedVersion: version,
          ...(action === 'approve' ? {} : { reason }),
        }),
      ),
    );
    if (
      result.id !== id ||
      result.version <= version ||
      result.status !==
        (
          {
            approve: 'approved',
            reject: 'rejected',
            revoke: 'revoked',
          } as const
        )[action]
    )
      throw new Error('Unexpected review receipt.');
    return result;
  }
  async upload(
    file: File,
    csrf: string,
    signal: AbortSignal,
  ): Promise<StagedIcon> {
    await validateIconFile(file);
    // Let fetch choose the multipart boundary instead of supplying a JSON content type.
    const data = new FormData();
    data.set('icon', file);
    const result = object(
      await this.json('/api/v1/admin/catalog/icons', signal, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
        body: data,
      }),
    );
    const iconPath = text(result.iconPath);
    parseAdminItem({
      id: 1,
      name: 'Staged',
      iconPath,
      origin: 'manual',
      overrides: [],
    });
    return {
      assetId: text(result.assetId),
      iconPath,
      expiresAt: timestamp(result.expiresAt),
    };
  }
  async create(
    fields: CreateItem,
    key: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<CreatedItem> {
    const data = object(
      await this.json(
        '/api/v1/admin/catalog/items',
        signal,
        this.write(csrf, fields, 'POST', key),
      ),
    );
    const pageIds = list(data.pageIds).map(text);
    unique(pageIds);
    if (
      pageIds.length !== fields.pageIds.length ||
      pageIds.some((id) => !fields.pageIds.includes(id))
    )
      throw new Error('Unexpected item memberships.');
    const item = parseAdminItem(data.item);
    if (item.name !== fields.name || item.origin !== 'manual')
      throw new Error('Unexpected created item.');
    return { item, pageIds, catalogRevision: text(data.catalogRevision) };
  }
  async order(
    pageId: string,
    ids: number[],
    version: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<AdminPage> {
    const data = object(
      await this.json(
        '/api/v1/admin/catalog/pages/' + encodeURIComponent(pageId) + '/order',
        signal,
        this.write(
          csrf,
          { orderedItemIds: ids, expectedVersion: version },
          'PUT',
        ),
      ),
    );
    const page = parseAdminPage(data.page),
      itemIds = page.itemIds;
    if (
      page.id !== pageId ||
      JSON.stringify(itemIds) !== JSON.stringify(ids) ||
      page.orderOrigin !== 'manual' ||
      page.version === version
    )
      throw new Error('Unexpected saved page order.');
    text(data.catalogRevision);
    return page;
  }
}

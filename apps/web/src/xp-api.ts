/** Validated aggregate tracker and private session HTTP reads. */
import { parseTracker } from './xp-tracker.ts';
import {
  parseAdminSession,
  type AdminSession,
  type XpClient,
} from './xp-model.ts';

export class XpRequestError extends Error {
  readonly status: number;
  constructor(status: number, detail?: string) {
    super(
      status === 409 &&
        detail ===
          'The XP tracker has reached its 2000-event capacity. Existing events can still be refreshed.'
        ? detail
        : status === 401
          ? 'Sign in with the admin password to import competitions.'
          : status === 403
            ? 'Your account is not allowed to import competitions.'
            : status === 409
              ? 'This preview is out of date. Preview the competition again.'
              : status === 429
                ? 'The source is rate limited. Try again shortly.'
                : [404, 501, 503].includes(status)
                  ? 'The XP service is not available yet.'
                  : 'Could not refresh XP. Your last successful results are preserved.',
    );
    this.status = status;
  }
}
interface Cached {
  data: unknown;
  etag: string | null;
}
export class LiveXpClient implements XpClient {
  private cache = new Map<string, Cached>();
  private request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request.bind(globalThis);
  }
  private async json(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
    staged?: Map<string, Cached>,
  ): Promise<unknown> {
    const cached = staged ? this.cache.get(path) : undefined;
    const response = await this.request(path, {
      ...options,
      signal,
      credentials: 'same-origin',
      cache: staged ? 'no-cache' : 'no-store',
      headers: {
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        ...options.headers,
      },
    });
    if (
      cached &&
      (response.status === 304 ||
        (response.ok &&
          cached.etag &&
          response.headers.get('ETag') === cached.etag))
    ) {
      void response.body?.cancel();
      staged?.set(path, cached);
      return cached.data;
    }
    if (!response.ok) {
      let detail: string | undefined;
      if (response.status === 409) {
        try {
          const body: unknown = await response.json();
          if (
            body &&
            typeof body === 'object' &&
            'error' in body &&
            typeof body.error === 'string'
          )
            detail = body.error;
        } catch {
          /* Fall back to the standard error for malformed responses. */
        }
      }
      throw new XpRequestError(response.status, detail);
    }
    const data: unknown = await response.json();
    staged?.set(path, { data, etag: response.headers.get('ETag') });
    return data;
  }
  async tracker(signal: AbortSignal) {
    const staged = new Map<string, Cached>();
    const result = parseTracker(
      await this.json('/api/v1/xp/tracker', signal, {}, staged),
    );
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const [path, entry] of staged) this.cache.set(path, entry);
    return result;
  }
  async session(signal: AbortSignal): Promise<AdminSession | null> {
    try {
      return parseAdminSession(await this.json('/api/v1/auth/session', signal));
    } catch (error) {
      if (error instanceof XpRequestError && error.status === 401) return null;
      throw error;
    }
  }
}

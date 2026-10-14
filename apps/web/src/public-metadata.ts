import { parseSettings } from './site-settings.ts';
import { parseBranding } from './branding.ts';
/** Three independent conditional resources; failed/canceled reads never replace a good value. */
export class PublicMetadataClient {
  private readonly cache = new Map<
    string,
    { etag: string | null; data: unknown }
  >();
  private async read<T>(
    path: string,
    parse: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<T> {
    const prior = this.cache.get(path);
    const response = await fetch(path, {
      signal,
      cache: 'no-cache',
      headers: prior?.etag ? { 'If-None-Match': prior.etag } : {},
    });
    if (
      prior &&
      (response.status === 304 ||
        (response.ok &&
          prior.etag &&
          response.headers.get('ETag') === prior.etag))
    ) {
      signal.throwIfAborted();
      void response.body?.cancel();
      return prior.data as T;
    }
    if (!response.ok) throw new Error('Public settings unavailable');
    const data = parse(await response.json());
    signal.throwIfAborted();
    this.cache.set(path, { etag: response.headers.get('ETag'), data });
    return data;
  }
  settings(signal: AbortSignal) {
    return this.read('/api/v1/settings', parseSettings, signal);
  }
  branding(hardcore: boolean, signal: AbortSignal) {
    return this.read(
      '/api/v1/branding' + (hardcore ? '/hardcore' : ''),
      parseBranding,
      signal,
    );
  }
}

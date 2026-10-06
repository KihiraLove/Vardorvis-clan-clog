import {
  parseCatalog,
  parseCollections,
  validateLog,
  type Catalog,
  type Collections,
  type LogData,
} from './model.ts';

export class LogUnavailable extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Public log request failed (${status})`);
    this.status = status;
  }
}
interface Cached<T> {
  data: T;
  etag: string | null;
}
export class PublicLogClient {
  private catalog: Cached<Catalog> | undefined;
  private collections: Cached<Collections> | undefined;
  private readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    // Native browser fetch requires the global receiver, not this adapter instance.
    this.request = request.bind(globalThis);
  }

  private async read<T>(
    path: string,
    cache: Cached<T> | undefined,
    parse: (value: unknown) => T,
    signal: AbortSignal,
  ): Promise<Cached<T>> {
    const response = await this.request(path, {
      signal,
      cache: 'no-cache',
      headers: cache?.etag ? { 'If-None-Match': cache.etag } : {},
    });
    if (response.status === 304 && cache) return cache;
    if (!response.ok) throw new LogUnavailable(response.status);
    return {
      data: parse(await response.json()),
      etag: response.headers.get('ETag'),
    };
  }

  async load(signal: AbortSignal): Promise<LogData> {
    const [catalog, collections] = await Promise.all([
      this.read('/api/v1/catalog', this.catalog, parseCatalog, signal),
      this.read(
        '/api/v1/collections',
        this.collections,
        parseCollections,
        signal,
      ),
    ]);
    const data = validateLog({
      catalog: catalog.data,
      collections: collections.data,
    });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Commit both caches only after a complete, mutually valid read.
    this.catalog = catalog;
    this.collections = collections;
    return data;
  }
}

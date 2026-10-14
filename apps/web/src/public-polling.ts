/** One visible-page cadence; resources retain independent requests and ETags. */
type Timer = ReturnType<typeof setTimeout>;
export interface PollEnvironment {
  visible(): boolean;
  listen(callback: () => void): () => void;
  interval(callback: () => void, ms: number): Timer;
  timeout(callback: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
  clearTimeout(timer: Timer): void;
}
const browser: PollEnvironment = {
  visible: () => document.visibilityState === 'visible',
  listen: (callback) => {
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  interval: (callback, ms) => setInterval(callback, ms),
  timeout: (callback, ms) => setTimeout(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  clearTimeout: (timer) => clearTimeout(timer),
};
type Entry = {
  read: (signal: AbortSignal) => Promise<void>;
  alive: boolean;
  pending: boolean;
  again: boolean;
  controller?: AbortController;
};
export class PublicPoller {
  private readonly entries = new Set<Entry>();
  private timer: Timer | undefined;
  private unlisten: (() => void) | undefined;
  private readonly environment: PollEnvironment;
  constructor(environment = browser) {
    this.environment = environment;
  }
  private cadence() {
    if (this.timer !== undefined) this.environment.clearInterval(this.timer);
    this.timer = undefined;
    if (this.entries.size && this.environment.visible())
      this.timer = this.environment.interval(() => {
        for (const entry of this.entries) this.invoke(entry, false);
      }, 25000);
  }
  private invoke(entry: Entry, queue: boolean) {
    if (!entry.alive || !this.environment.visible()) return;
    if (entry.pending) {
      if (queue) entry.again = true;
      return;
    }
    entry.pending = true;
    entry.again = false;
    const controller = new AbortController();
    entry.controller = controller;
    const timeout = this.environment.timeout(
      () =>
        controller.abort(
          new DOMException('Public read timed out', 'TimeoutError'),
        ),
      10000,
    );
    void Promise.resolve()
      .then(() => {
        if (entry.alive && !controller.signal.aborted)
          return publicRead(entry.read(controller.signal), controller.signal);
      })
      .catch(() => undefined)
      .finally(() => {
        this.environment.clearTimeout(timeout);
        entry.pending = false;
        if (entry.again) this.invoke(entry, false);
      });
  }
  subscribe(read: Entry['read'], immediate = true) {
    const entry: Entry = { read, alive: true, pending: false, again: false };
    this.entries.add(entry);
    if (!this.unlisten)
      this.unlisten = this.environment.listen(() => {
        this.cadence();
        for (const entry of this.entries) {
          if (this.environment.visible()) this.invoke(entry, true);
          else
            entry.controller?.abort(
              new DOMException('Page hidden', 'AbortError'),
            );
        }
      });
    if (this.entries.size === 1) this.cadence();
    if (immediate) this.invoke(entry, false);
    return {
      refresh: () => this.invoke(entry, true),
      stop: () => {
        entry.alive = false;
        entry.again = false;
        entry.controller?.abort(new DOMException('View removed', 'AbortError'));
        this.entries.delete(entry);
        if (!this.entries.size) {
          this.cadence();
          this.unlisten?.();
          this.unlisten = undefined;
        }
      },
    };
  }
  snapshot() {
    return {
      subscribers: this.entries.size,
      pending: [...this.entries].filter((entry) => entry.pending).length,
      timer: this.timer !== undefined,
    };
  }
}
export const publicPoller = new PublicPoller();
export const reportPublicFailure = (signal: AbortSignal) =>
  !signal.aborted || signal.reason?.name === 'TimeoutError';
export function publicRead<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Bounded in-process admission. Reject before work; never queue network writes. */
export class WorkloadError extends Error {
  constructor(readonly retryAfterSeconds = 1) {
    super(`Service is busy. Try again in ${retryAfterSeconds} seconds.`);
  }
}
export interface WorkLimit {
  concurrent: number;
  perMinute: number;
}
type Window = { active: number; used: number; resetAt: number };
export class WorkBudget {
  private readonly scopes: Map<string, Window>[];
  private readonly total: Window = { active: 0, used: 0, resetAt: 0 };
  private stopped = false;
  private accepted = 0;
  private rejected = 0;
  constructor(
    private readonly global: WorkLimit,
    private readonly limits: readonly WorkLimit[],
    private readonly maxKeys = 512,
    private readonly clock = Date.now,
  ) {
    for (const limit of [global, ...limits])
      if (
        !Number.isInteger(limit.concurrent) ||
        limit.concurrent < 1 ||
        !Number.isInteger(limit.perMinute) ||
        limit.perMinute < 1
      )
        throw new Error('Invalid work budget');
    if (!Number.isInteger(maxKeys) || maxKeys < 1)
      throw new Error('Invalid key budget');
    this.scopes = limits.map(() => new Map());
  }
  private expire(window: Window, now: number) {
    if (window.resetAt <= now) {
      window.used = 0;
      window.resetAt = now + 60000;
    }
  }
  acquire(keys: readonly string[]): () => void {
    if (
      keys.length !== this.scopes.length ||
      keys.some((key) => !key || key.length > 200)
    )
      throw new Error('Invalid work scope');
    const now = this.clock();
    const deny = (seconds = 1): never => {
      this.rejected++;
      throw new WorkloadError(Math.max(1, Math.ceil(seconds)));
    };
    if (this.stopped) deny();
    this.expire(this.total, now);
    const windows: Window[] = [this.total];
    for (const [i, scope] of this.scopes.entries()) {
      // At most maxKeys entries are examined; no timers or unbounded key cache.
      for (const [key, window] of scope)
        if (!window.active && window.resetAt <= now) scope.delete(key);
      const existing = scope.get(keys[i]!);
      if (!existing && scope.size >= this.maxKeys) deny(60);
      const window = existing ?? { active: 0, used: 0, resetAt: now + 60000 };
      this.expire(window, now);
      windows.push(window);
    }
    for (const [i, limit] of [this.global, ...this.limits].entries()) {
      const window = windows[i]!;
      if (window.active >= limit.concurrent) deny();
      if (window.used >= limit.perMinute) deny((window.resetAt - now) / 1000);
    }
    // Check all dimensions before consuming any rate/concurrency capacity.
    for (const [i, scope] of this.scopes.entries())
      scope.set(keys[i]!, windows[i + 1]!);
    for (const window of windows) {
      window.active++;
      window.used++;
    }
    this.accepted++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        for (const window of windows) window.active--;
      }
    };
  }
  async run<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquire(keys);
    try {
      return await operation();
    } finally {
      release();
    }
  }
  close() {
    this.stopped = true;
  }
  snapshot() {
    return {
      active: this.total.active,
      keys: this.scopes.map((scope) => scope.size),
      accepted: this.accepted,
      rejected: this.rejected,
      stopped: this.stopped,
    };
  }
}

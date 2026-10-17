/** Fixed diagnostic fields and drain accounting shared by the two Node adapters. */
export const errorCategories = [
  'auth',
  'forbidden',
  'validation',
  'conflict',
  'overload',
  'timeout',
  'database',
  'dependency',
  'unexpected',
  'uncertain',
  'acknowledgement',
] as const;
export type ErrorCategory = (typeof errorCategories)[number];
const codes = [
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'INVALID_INPUT',
  'CONFLICT',
  'OVERLOADED',
  'TIMEOUT',
  'DB_CONNECTION',
  'DB_SHUTDOWN',
  'DB_UNIQUE',
  'DB_REFERENCE',
  'DB_RETRY',
  'DB_TIMEOUT',
  'UNAVAILABLE',
  'UNEXPECTED',
  'RETRY_REJECTED',
  'RETRIES_EXHAUSTED',
  'INVALID_RECEIPT',
  'ACK_FAILED',
  'DRAIN_STARTED',
  'DRAIN_COMPLETE',
  'DRAIN_EXPIRED',
  'READY',
  'NOT_READY',
  'PROCESS_FAILED',
  'GATEWAY_CONNECTED',
  'REQUEST_COMPLETE',
  'RECEIPT_KNOWN',
] as const;
type Code = (typeof codes)[number];
export function safeFailure(
  error: unknown,
  status?: number,
): { category: ErrorCategory; code: Code } {
  let code: unknown;
  try {
    code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
  } catch {
    /* Do not invoke unsafe driver object inspection while reporting a failure. */
  }
  if (code === '23505') return { category: 'conflict', code: 'DB_UNIQUE' };
  if (code === '23503') return { category: 'validation', code: 'DB_REFERENCE' };
  if (code === '40001' || code === '40P01')
    return { category: 'database', code: 'DB_RETRY' };
  if (code === '57014') return { category: 'timeout', code: 'DB_TIMEOUT' };
  if (typeof code === 'string' && ['57P01', '57P02', '57P03'].includes(code))
    return { category: 'database', code: 'DB_SHUTDOWN' };
  if (
    typeof code === 'string' &&
    (['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(code) ||
      /^08[\dA-Z]{3}$/u.test(code))
  )
    return { category: 'database', code: 'DB_CONNECTION' };
  if (
    code === 'ETIMEDOUT' ||
    (error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(error.name))
  )
    return { category: 'timeout', code: 'TIMEOUT' };
  if (status === 401) return { category: 'auth', code: 'AUTH_REQUIRED' };
  if (status === 403) return { category: 'forbidden', code: 'ACCESS_DENIED' };
  if (status === 409) return { category: 'conflict', code: 'CONFLICT' };
  if (status === 429) return { category: 'overload', code: 'OVERLOADED' };
  if (status && status >= 400 && status < 500)
    return { category: 'validation', code: 'INVALID_INPUT' };
  return status && status >= 500
    ? { category: 'dependency', code: 'UNAVAILABLE' }
    : { category: 'unexpected', code: 'UNEXPECTED' };
}
export const safeCorrelation = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  (/^\d{17,20}$/u.test(value) ||
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value) ||
    /^req-[a-z\d]{1,16}$/u.test(value))
    ? value
    : undefined;
type Event =
  'request' | 'failure' | 'readiness' | 'shutdown' | 'receipt' | 'process';
type Operation =
  | 'http'
  | 'submission'
  | 'autocomplete'
  | 'pool'
  | 'runtime'
  | 'gateway'
  | 'readiness';
type Detail = {
  operation: Operation;
  category?: ErrorCategory;
  code: Code;
  correlation?: string | undefined;
  receipt?: string | undefined;
  active?: number;
  queued?: number;
  status?: number;
  pending?: readonly string[];
};
export class OperationalDiagnostics {
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly service: 'api' | 'bot',
    private readonly sink: (record: Record<string, unknown>) => void = () => {},
  ) {}
  record(event: Event, detail: Detail) {
    // Explicitly select fields: never spread an Error, request, claim, connection or provider body.
    const category =
      detail.category && errorCategories.includes(detail.category)
        ? detail.category
        : undefined;
    const code = codes.includes(detail.code) ? detail.code : 'UNEXPECTED';
    const key =
      event + ':' + detail.operation + ':' + (category ?? 'none') + ':' + code;
    this.counts.set(
      key,
      Math.min(Number.MAX_SAFE_INTEGER, (this.counts.get(key) ?? 0) + 1),
    );
    const record: Record<string, unknown> = {
      service: this.service,
      event,
      operation: detail.operation,
      code,
    };
    if (category) record.category = category;
    for (const field of ['correlation', 'receipt'] as const) {
      const id = safeCorrelation(detail[field]);
      if (id) record[field] = id;
    }
    for (const field of ['active', 'queued', 'status'] as const) {
      const n = detail[field];
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
        record[field] = n;
    }
    if (detail.pending)
      record.pending = detail.pending
        .slice(0, 32)
        .map(safeCorrelation)
        .filter(Boolean);
    try {
      this.sink(record);
    } catch {
      /* A log destination cannot change a durable receipt. */
    }
  }
  snapshot() {
    return Object.fromEntries(this.counts);
  }
}
export class WorkDrain {
  private stopping = false;
  private readonly active = new Map<symbol, string | undefined>();
  private readonly waiters: (() => void)[] = [];
  enter(correlation?: string, admitted = false): (() => void) | undefined {
    if (this.stopping && !admitted) return undefined;
    const key = Symbol();
    this.active.set(key, safeCorrelation(correlation));
    return () => {
      if (!this.active.delete(key)) return;
      if (!this.active.size) for (const done of this.waiters.splice(0)) done();
    };
  }
  stop(): Promise<void> {
    this.stopping = true;
    return this.active.size
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
  snapshot() {
    return {
      stopping: this.stopping,
      active: this.active.size,
      pending: [
        ...new Set(
          [...this.active.values()].filter((id): id is string => !!id),
        ),
      ].slice(0, 32),
    };
  }
}
/** The caller must terminate on expiry; do not interpret expiry as rollback. */
export async function withinDeadline(
  operation: () => Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

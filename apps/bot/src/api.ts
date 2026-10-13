/** Restrict Discord data access to two bot-only API routes. No direct database access. */
import { closedCollectionPageMessage } from '@clog/domain';
export interface Candidate {
  id: number;
  name: string;
}
export interface Claim {
  interactionId: string;
  guildId: string;
  actorDiscordId: string;
  rawItemText: string;
  itemId?: number;
  collectorName: string;
  proofUrl: string;
  hardcore: boolean;
}
export interface Receipt {
  submissionId: string;
  interactionId: string;
  status: 'pending';
  submittedAt: string;
  collectedOn: string;
  dateSource: 'collector' | 'submission_default';
  hardcore: boolean;
  resolution: 'resolved' | 'needs_match';
  itemId: number | null;
  candidates: Candidate[];
  creditOccupied: boolean;
}
export interface BotApi {
  search(query: string): Promise<Candidate[]>;
  submit(claim: Claim): Promise<Receipt>;
}
export class BotApiError extends Error {
  constructor(
    readonly status: number,
    message = 'Bot intake API unavailable',
  ) {
    super(message);
  }
}

/**
 * A submission may have committed even though its receipt could not be
 * verified. Only the Discord interaction ID is carried for reconciliation,
 * never a driver error, response body, credential or evidence URL.
 */
export class UnconfirmedSubmissionError extends Error {
  constructor(
    readonly interactionId: string,
    readonly reason: 'retry-rejected' | 'retries-exhausted' | 'invalid-receipt',
  ) {
    super('Submission receipt unconfirmed');
    this.name = 'UnconfirmedSubmissionError';
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const candidate = (value: unknown): value is Candidate =>
  record(value) &&
  Number.isSafeInteger(value.id) &&
  Number(value.id) > 0 &&
  typeof value.name === 'string' &&
  value.name.trim().length > 0;
function parseReceipt(value: unknown, interactionId: string): Receipt {
  if (
    !record(value) ||
    value.status !== 'pending' ||
    value.interactionId !== interactionId ||
    typeof value.submissionId !== 'string' ||
    !/^[\da-f-]{36}$/iu.test(value.submissionId) ||
    typeof value.submittedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.submittedAt)) ||
    typeof value.collectedOn !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.collectedOn) ||
    !['collector', 'submission_default'].includes(String(value.dateSource)) ||
    typeof value.hardcore !== 'boolean' ||
    !['resolved', 'needs_match'].includes(String(value.resolution)) ||
    !(
      value.itemId === null ||
      (Number.isSafeInteger(value.itemId) && Number(value.itemId) > 0)
    ) ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(candidate) ||
    typeof value.creditOccupied !== 'boolean' ||
    (value.resolution === 'resolved') !== (value.itemId !== null) ||
    (value.itemId === null && value.creditOccupied)
  )
    throw new BotApiError(502, 'Invalid durable receipt from the intake API');
  return value as unknown as Receipt;
}
export class HttpBotApi implements BotApi {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
    private readonly searchTimeoutMs = 1900,
    private readonly submitTimeoutMs = 6500,
  ) {}

  /** Readiness verifies the authenticated bot route and database-backed catalog. */
  async checkReady(): Promise<boolean> {
    try {
      const url = new URL('/api/v1/bot/items', this.origin);
      url.searchParams.set('q', '');
      url.searchParams.set('limit', '1');
      const response = await this.request(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.searchTimeoutMs),
        headers: { Authorization: 'Bearer ' + this.token },
      });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return (
        record(body) &&
        Array.isArray(body.items) &&
        body.items.length <= 1 &&
        body.items.every(candidate)
      );
    } catch {
      return false;
    }
  }

  async search(query: string): Promise<Candidate[]> {
    const url = new URL('/api/v1/bot/items', this.origin);
    url.searchParams.set('q', query.slice(0, 200));
    url.searchParams.set('limit', '25');
    const response = await this.request(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(this.searchTimeoutMs),
      headers: { Authorization: 'Bearer ' + this.token },
    });
    if (!response.ok) throw new BotApiError(response.status);
    const body: unknown = await response.json();
    if (
      !record(body) ||
      !Array.isArray(body.items) ||
      body.items.length > 25 ||
      !body.items.every(candidate)
    )
      throw new BotApiError(502, 'Invalid autocomplete response');
    return body.items;
  }

  async submit(claim: Claim): Promise<Receipt> {
    // Both attempts must have exactly the same idempotency key and body.
    // Network/5xx failures can happen AFTER commit. A later 4xx response
    // cannot prove an earlier attempt was rolled back.
    const body = JSON.stringify(claim);
    let uncertain = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let accepted = false;
      try {
        const response = await this.request(
          new URL('/api/v1/bot/submissions', this.origin),
          {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(this.submitTimeoutMs),
            headers: {
              Authorization: 'Bearer ' + this.token,
              'Content-Type': 'application/json',
            },
            body,
          },
        );
        if (response.status === 403) {
          let responseBody: unknown;
          try {
            responseBody = await response.json();
          } catch {
            /* Keep unknown failures private. */
          }
          if (
            record(responseBody) &&
            responseBody.error === closedCollectionPageMessage
          )
            throw new BotApiError(403, closedCollectionPageMessage);
        }
        if (response.status !== 200 && response.status !== 201)
          throw new BotApiError(response.status);
        accepted = true;
        const value: unknown = await response.json();
        return parseReceipt(value, claim.interactionId);
      } catch (error) {
        // A 200/201 with a missing, malformed or mismatched receipt still
        // cannot confirm the stored outcome. Do not retry or invent a receipt.
        if (accepted)
          throw new UnconfirmedSubmissionError(
            claim.interactionId,
            'invalid-receipt',
          );
        const retryable =
          !(error instanceof BotApiError) || error.status >= 500;
        if (retryable) uncertain = true;
        if (!retryable) {
          if (uncertain)
            throw new UnconfirmedSubmissionError(
              claim.interactionId,
              'retry-rejected',
            );
          throw error;
        }
        if (attempt === 1)
          throw new UnconfirmedSubmissionError(
            claim.interactionId,
            'retries-exhausted',
          );
      }
    }
    throw new UnconfirmedSubmissionError(
      claim.interactionId,
      'retries-exhausted',
    );
  }
}

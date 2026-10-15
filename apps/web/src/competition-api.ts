import {
  competitionScope,
  type CompetitionImportAction,
  type CompetitionKind,
  type CompetitionLifecycle,
  type WomCompetition,
} from '@clog/domain';
import {
  amount,
  competitionUrl,
  identity,
  list,
  object,
  parseChanges,
  text,
  timestamp,
  unique,
  type ImportChange,
} from './xp-model.ts';
export interface CompetitionImportPreview {
  previewToken: string;
  expectedRevision: string;
  scheduleRevision: string;
  expiresAt: string;
  competition: WomCompetition;
  lifecycle: CompetitionLifecycle;
  action: CompetitionImportAction;
  scheduleStartsAt: string | null;
  pageIds: string[];
  pages: { id: string; name: string }[];
  participants: { playerId: number; displayName: string; gained: string }[];
  changes: ImportChange[];
  warnings: string[];
}
export interface CompetitionClient {
  activities(
    signal: AbortSignal,
  ): Promise<{ serverNow: string; competitions: WomCompetition[] }>;
  preview(
    url: string,
    csrf: string,
    signal: AbortSignal,
    pageIds?: string[],
  ): Promise<CompetitionImportPreview>;
  apply(
    preview: CompetitionImportPreview,
    csrf: string,
    key: string,
    acknowledged: boolean,
    signal: AbortSignal,
  ): Promise<{ outcome: 'applied' | 'unchanged' }>;
}
export function parseWomCompetition(value: unknown): WomCompetition {
  const c = object(value),
    id = identity(c.id),
    source = competitionUrl(text(c.sourceUrl));
  if (source.id !== id || !['SKILL', 'ACTIVITY'].includes(String(c.kind)))
    throw new Error('Invalid competition identity or kind.');
  const startsAt = timestamp(c.startsAt),
    endsAt = timestamp(c.endsAt),
    metrics = list(c.metrics).map(text);
  if (Date.parse(endsAt) <= Date.parse(startsAt) || !metrics.length)
    throw new Error('Invalid competition period or metrics.');
  unique(metrics);
  if (competitionScope(metrics).kind !== c.kind)
    throw new Error('Competition kind does not match its WOM metric scope.');
  return {
    id,
    kind: c.kind as CompetitionKind,
    title: text(c.title),
    sourceUrl: source.url,
    metrics,
    startsAt,
    endsAt,
  };
}
export class CompetitionRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export class LiveCompetitionClient implements CompetitionClient {
  private activityCache:
    | {
        etag: string | null;
        data: { serverNow: string; competitions: WomCompetition[] };
      }
    | undefined;
  private async json(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
  ): Promise<unknown> {
    const response = await fetch(path, {
      ...options,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    // Authentication status is authoritative even when a proxy returns HTML
    // or an empty body, so expiry cannot be hidden by JSON parse failure.
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (!response.ok)
        throw new CompetitionRequestError(
          response.status,
          'Competition request failed.',
        );
      throw new Error('Invalid competition response.');
    }
    if (!response.ok)
      throw new CompetitionRequestError(
        response.status,
        typeof object(value).error === 'string'
          ? String(object(value).error)
          : 'Competition request failed.',
      );
    return value;
  }
  async activities(signal: AbortSignal) {
    const response = await fetch('/api/v1/competitions/activities', {
      signal,
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: this.activityCache?.etag
        ? { 'If-None-Match': this.activityCache.etag }
        : {},
    });
    const clock = response.headers.get('X-Server-Now');
    if (
      this.activityCache &&
      (response.status === 304 ||
        (response.ok &&
          clock &&
          this.activityCache.etag &&
          response.headers.get('ETag') === this.activityCache.etag))
    ) {
      signal.throwIfAborted();
      if (!clock) throw new Error('Missing current competition clock.');
      void response.body?.cancel();
      return { ...this.activityCache.data, serverNow: timestamp(clock) };
    }
    if (!response.ok)
      throw new CompetitionRequestError(
        response.status,
        'Competitions could not be refreshed.',
      );
    const value = object(await response.json());
    const competitions = list(value.competitions).map(parseWomCompetition);
    if (competitions.some((c) => c.kind !== 'ACTIVITY'))
      throw new Error('Invalid activity listing.');
    unique(competitions.map((c) => c.id));
    const data = {
      serverNow: timestamp(clock ?? value.serverNow),
      competitions,
    };
    signal.throwIfAborted();
    this.activityCache = { etag: response.headers.get('ETag'), data };
    return data;
  }
  async preview(
    url: string,
    csrf: string,
    signal: AbortSignal,
    pageIds?: string[],
  ) {
    const p = object(
      await this.json('/api/v1/admin/competitions/preview', signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          competitionUrl: competitionUrl(url).url,
          ...(pageIds ? { pageIds } : {}),
        }),
      }),
    );
    const competition = parseWomCompetition(p.competition);
    if (competition.id !== competitionUrl(url).id)
      throw new Error(
        'Competition preview identity does not match the requested WOM link.',
      );
    if (
      !['future', 'running', 'finished'].includes(String(p.lifecycle)) ||
      ![
        'create-schedule',
        'preserve-schedule',
        'preserve-deletion',
        'import-results',
        'import-metadata',
      ].includes(String(p.action))
    )
      throw new Error('Invalid import action.');
    const participants = list(p.participants).map((entry) => {
      const r = object(entry),
        gains = r.gains
          ? Object.values(object(r.gains)).map((n) => amount(n))
          : undefined;
      return {
        playerId: identity(r.playerId),
        displayName: text(r.displayName),
        gained: gains
          ? gains.reduce((sum, n) => sum + BigInt(n), 0n).toString()
          : amount(r.gained),
      };
    });
    unique(participants.map((r) => r.playerId));
    if (p.lifecycle !== 'finished' && participants.length)
      throw new Error('Live imports must contain metadata only.');
    const metadataOnly =
      competition.kind === 'SKILL' && p.lifecycle !== 'finished';
    if (
      metadataOnly !== (p.action === 'import-metadata') ||
      (metadataOnly &&
        (list(p.pageIds).length ||
          list(p.pages).length ||
          list(p.changes).length ||
          p.scheduleStartsAt !== null))
    )
      throw new Error('Invalid metadata-only SKILL preview.');
    return {
      previewToken: text(p.previewToken),
      expectedRevision: text(p.expectedRevision),
      scheduleRevision: text(p.scheduleRevision),
      expiresAt: timestamp(p.expiresAt),
      competition,
      lifecycle: p.lifecycle as CompetitionLifecycle,
      action: p.action as CompetitionImportPreview['action'],
      scheduleStartsAt:
        p.scheduleStartsAt === null ? null : timestamp(p.scheduleStartsAt),
      pageIds: list(p.pageIds).map(text),
      pages: list(p.pages).map((r) => {
        const v = object(r);
        return { id: text(v.id), name: text(v.name) };
      }),
      participants,
      changes: parseChanges(p.changes),
      warnings: list(p.warnings).map(text),
    };
  }
  async apply(
    p: CompetitionImportPreview,
    csrf: string,
    key: string,
    acknowledged: boolean,
    signal: AbortSignal,
  ) {
    const r = object(
      await this.json('/api/v1/admin/competitions/imports', signal, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          previewToken: p.previewToken,
          expectedRevision: p.expectedRevision,
          scheduleRevision: p.scheduleRevision,
          acknowledgeCorrections: acknowledged,
        }),
      }),
    );
    if (!['applied', 'unchanged'].includes(String(r.outcome)))
      throw new Error('Invalid import receipt.');
    return { outcome: r.outcome as 'applied' | 'unchanged' };
  }
}

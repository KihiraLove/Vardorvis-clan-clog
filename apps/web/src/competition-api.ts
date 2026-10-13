import {
  competitionLifecycle,
  competitionImportAction,
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
  type XpClient,
  type ImportPreview,
} from './xp-model.ts';
import type { AdminClient } from './admin-model.ts';
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
    const value = object(
      await this.json('/api/v1/competitions/activities', signal),
    );
    const competitions = list(value.competitions).map(parseWomCompetition);
    if (competitions.some((c) => c.kind !== 'ACTIVITY'))
      throw new Error('Invalid activity listing.');
    unique(competitions.map((c) => c.id));
    return { serverNow: timestamp(value.serverNow), competitions };
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
/** Controlled preview fixtures mirror the live lifecycle and never fetch WOM. */
export class PreviewCompetitionClient implements CompetitionClient {
  private readonly scheduleClient: AdminClient | undefined;
  private readonly xpClient: XpClient | undefined;
  private readonly onSkillMetadata:
    ((competition: WomCompetition) => void) | undefined;
  constructor(
    scheduleClient?: AdminClient,
    xpClient?: XpClient,
    onSkillMetadata?: (competition: WomCompetition) => void,
  ) {
    this.scheduleClient = scheduleClient;
    this.xpClient = xpClient;
    this.onSkillMetadata = onSkillMetadata;
  }
  private readonly fixtureNow = Date.now();
  private stored = new Map<number, WomCompetition>();
  private schedules = new Map<number, string>();
  private version = 1;
  private previews = new Map<string, CompetitionImportPreview>();
  private xpPreviews = new Map<string, ImportPreview>();
  private receipts = new Map<
    string,
    {
      token: string;
      acknowledged: boolean;
      finishedSkill: boolean;
      outcome: 'applied' | 'unchanged';
    }
  >();
  async activities(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const day = 86400000,
      now = this.fixtureNow;
    const samples = [
      ['Past boss week', now - 3 * day, now - day],
      ['Running boss week', now - day, now + day],
      ['Future boss week', now + day, now + 3 * day],
    ] as const;
    const rows = new Map<number, WomCompetition>(
      samples.map(([title, start, end], i) => [
        3001 + i,
        {
          id: 3001 + i,
          kind: 'ACTIVITY',
          title,
          sourceUrl: 'https://wiseoldman.net/competitions/' + (3001 + i),
          metrics: ['vardorvis'],
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
        },
      ]),
    );
    for (const c of this.stored.values())
      if (c.kind === 'ACTIVITY') rows.set(c.id, c);
    return {
      serverNow: new Date().toISOString(),
      competitions: [...rows.values()].sort(
        (a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt) || b.id - a.id,
      ),
    };
  }
  async preview(
    url: string,
    csrf: string,
    signal: AbortSignal,
    pageIds?: string[],
  ) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const { id } = competitionUrl(url),
      now = this.fixtureNow,
      day = 86400000,
      stage = id % 3;
    // Stable fixture metadata determines kind, just as WOM metadata does live.
    const fixtureMetrics =
      id >= 1000 && id < 2000
        ? [id === 1002 ? 'overall' : 'attack']
        : ['vardorvis'];
    const { kind, skills: fixtureSkills } = competitionScope(fixtureMetrics);
    if (kind === 'SKILL' && pageIds?.length)
      throw new CompetitionRequestError(
        422,
        'SKILL imports do not open collection log pages.',
      );
    const prior = this.stored.get(id);
    if (prior && prior.kind !== kind)
      throw new Error('This competition already has a different kind.');
    const sampleSkill = kind === 'SKILL' && [1001, 1002].includes(id);
    const xpPreview =
      sampleSkill && this.xpClient
        ? await this.xpClient.preview(url, csrf, signal)
        : undefined;
    const startsAt =
        xpPreview?.competition.startsAt ??
        new Date(now + (stage === 0 ? day : -2 * day)).toISOString(),
      endsAt =
        xpPreview?.competition.endsAt ??
        new Date(now + (stage === 2 ? -day : 3 * day)).toISOString();
    const competition: WomCompetition = {
      id,
      kind,
      title:
        xpPreview?.competition.title ??
        (kind === 'SKILL'
          ? 'Sample skill competition'
          : 'Sample boss competition'),
      sourceUrl: competitionUrl(url).url,
      metrics: xpPreview?.competition.skills ?? fixtureMetrics,
      startsAt,
      endsAt,
    };
    const lifecycle = competitionLifecycle(competition, Date.now());
    if (this.scheduleClient) {
      const session = await this.scheduleClient.session(signal);
      if (!session)
        throw new CompetitionRequestError(401, 'Sign in to continue.');
      if (
        session.role !== 'admin' &&
        kind === 'SKILL' &&
        lifecycle === 'finished'
      )
        throw new CompetitionRequestError(
          403,
          'Only the administrator can import XP results.',
        );
    }
    const catalog =
      kind === 'ACTIVITY' && this.scheduleClient
        ? await this.scheduleClient.catalog(signal)
        : undefined;
    const scheduleState = this.scheduleClient
      ? await this.scheduleClient.scheduling(signal)
      : undefined;
    const linked = scheduleState?.schedules.find(
      (s) => s.id === this.schedules.get(id),
    );
    const pages =
      kind === 'SKILL'
        ? []
        : (catalog?.pages.map((p) => ({ id: p.id, name: p.name })) ?? [
            { id: 'vardorvis', name: 'Vardorvis' },
            { id: 'the-whisperer', name: 'The Whisperer' },
          ]);
    const action = competitionImportAction(
      kind,
      lifecycle,
      this.schedules.has(id),
      !!linked,
    );
    const preview: CompetitionImportPreview = {
      previewToken: crypto.randomUUID(),
      expectedRevision: 'preview-' + this.version,
      scheduleRevision: scheduleState?.revision ?? 'preview-1',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      competition,
      lifecycle,
      action,
      scheduleStartsAt:
        kind === 'SKILL' || lifecycle === 'finished'
          ? null
          : (linked?.startsAt ??
            (lifecycle === 'running' ? new Date().toISOString() : startsAt)),
      pageIds:
        kind === 'SKILL' || lifecycle === 'finished'
          ? []
          : (linked?.pageIds ??
            pageIds ??
            (kind === 'ACTIVITY' ? ['vardorvis'] : [])),
      pages,
      participants:
        lifecycle === 'finished'
          ? xpPreview
            ? xpPreview.participants
                .filter(
                  (p) =>
                    Object.values(p.gains).every((n) => n !== null) &&
                    Object.values(p.gains).some((n) => BigInt(n!) > 0n),
                )
                .map((p) => ({
                  playerId: p.playerId,
                  displayName: p.displayName,
                  gained: Object.values(p.gains)
                    .reduce((sum, n) => sum + BigInt(n!), 0n)
                    .toString(),
                }))
            : [{ playerId: 1, displayName: 'KihiraVD', gained: '12345678' }]
          : [],
      changes:
        xpPreview?.changes ??
        (kind === 'SKILL' && lifecycle === 'finished'
          ? fixtureSkills.map((skill) => ({
              skill,
              before: '0',
              after: skill === 'attack' ? '12345678' : '0',
              change: skill === 'attack' ? '12345678' : '0',
            }))
          : []),
      warnings: [
        'Preview mode only. No server data is changed.',
        ...(kind === 'ACTIVITY' &&
        scheduleState &&
        !scheduleState.enabled &&
        lifecycle !== 'finished'
          ? ['Scheduling is disabled. This import will not enable enforcement.']
          : []),
      ],
    };
    if (xpPreview) this.xpPreviews.set(preview.previewToken, xpPreview);
    this.previews.set(preview.previewToken, preview);
    return structuredClone(preview);
  }
  async apply(
    p: CompetitionImportPreview,
    csrf: string,
    key: string,
    ack: boolean,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const replay = this.receipts.get(key);
    const current = this.previews.get(p.previewToken);
    const finishedSkill =
      replay?.finishedSkill ??
      (current?.competition.kind === 'SKILL' &&
        current.lifecycle === 'finished');
    if (this.scheduleClient) {
      const session = await this.scheduleClient.session(signal);
      if (!session)
        throw new CompetitionRequestError(401, 'Sign in to continue.');
      if (session.role !== 'admin' && finishedSkill)
        throw new CompetitionRequestError(
          403,
          'Only the administrator can import XP results.',
        );
    }
    if (replay) {
      if (replay.token !== p.previewToken || replay.acknowledged !== ack)
        throw new CompetitionRequestError(409, 'Key reused.');
      return { outcome: replay.outcome };
    }
    if (
      !current ||
      p.expectedRevision !== 'preview-' + this.version ||
      p.expectedRevision !== current.expectedRevision ||
      p.scheduleRevision !== current.scheduleRevision ||
      Date.now() >= Date.parse(current.expiresAt)
    )
      throw new CompetitionRequestError(409, 'Preview changed. Preview again.');
    p = current;
    const lifecycle = competitionLifecycle(p.competition, Date.now());
    if ((lifecycle === 'finished') !== (p.lifecycle === 'finished'))
      throw new CompetitionRequestError(
        409,
        'Competition finished. Preview again.',
      );
    if (this.scheduleClient) {
      if (
        (await this.scheduleClient.scheduling(signal)).revision !==
        p.scheduleRevision
      )
        throw new CompetitionRequestError(
          409,
          'Scheduling changed. Preview again.',
        );
    }
    if (p.action === 'create-schedule') {
      if (!p.pageIds.length) throw new Error('Choose at least one page.');
      if (this.scheduleClient) {
        const state = await this.scheduleClient.saveSchedule(
          {
            title: p.competition.title,
            startsAt:
              lifecycle === 'running'
                ? new Date().toISOString()
                : p.competition.startsAt,
            endsAt: p.competition.endsAt,
            pageIds: p.pageIds,
          },
          p.scheduleRevision,
          csrf,
          signal,
        );
        const saved = state.schedules.find(
          (s) =>
            !this.schedules.has(p.competition.id) &&
            s.title === p.competition.title &&
            s.endsAt === p.competition.endsAt,
        );
        if (saved) this.schedules.set(p.competition.id, saved.id);
      }
    }
    const xpPreview = this.xpPreviews.get(p.previewToken);
    const outcome =
      xpPreview && this.xpClient
        ? (await this.xpClient.apply(xpPreview, csrf, key, signal, ack)).outcome
        : JSON.stringify(this.stored.get(p.competition.id)) ===
            JSON.stringify(p.competition)
          ? 'unchanged'
          : 'applied';
    this.stored.set(p.competition.id, p.competition);
    if (p.action === 'import-metadata') this.onSkillMetadata?.(p.competition);
    if (outcome === 'applied') this.version++;
    this.receipts.set(key, {
      token: p.previewToken,
      acknowledged: ack,
      finishedSkill,
      outcome,
    });
    return { outcome };
  }
}

import {
  competitionLifecycle,
  competitionImportAction,
  competitionScope,
  type WomCompetition,
} from '@clog/domain';
import {
  competitionUrl,
  type XpClient,
  type ImportPreview,
} from '../xp-model.ts';
import type { AdminClient } from '../admin-model.ts';
import {
  CompetitionRequestError,
  type CompetitionClient,
  type CompetitionImportPreview,
} from '../competition-api.ts';
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

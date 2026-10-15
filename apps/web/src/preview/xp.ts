/** Simulate two WOM competitions and reconciliation locally; no source/network persistence. */
import {
  competitionUrl,
  zeroTotals,
  skills,
  type AdminSession,
  type ApplyResult,
  type CompetitionDetail,
  type ImportEntry,
  type ImportHistoryPage,
  type ImportPreview,
  type Member,
  type SkillId,
  type XpClient,
  type XpSnapshot,
} from '../xp-model.ts';
import { XpRequestError } from '../xp-api.ts';
import { podiumFromParticipants } from '../xp-tracker.ts';
import { competitionScope, type WomCompetition } from '@clog/domain';

export class PreviewXpClient implements XpClient {
  private readonly getSession:
    ((signal: AbortSignal) => Promise<AdminSession | null>) | undefined;
  constructor(
    getSession?: (signal: AbortSignal) => Promise<AdminSession | null>,
  ) {
    this.getSession = getSession;
  }
  private revision = 0;
  private sourceVersion = 0;
  private stored = new Map<number, CompetitionDetail>();
  private metadata = new Map<number, WomCompetition>();
  private previews = new Map<string, ImportPreview>();
  private receipts = new Map<string, { token: string; result: ApplyResult }>();
  private imports: ImportEntry[] = [];
  storeMetadata(competition: WomCompetition) {
    if (competition.kind !== 'SKILL')
      throw new Error('Only SKILL competitions belong in the XP tracker.');
    if (
      JSON.stringify(this.metadata.get(competition.id)) !==
      JSON.stringify(competition)
    ) {
      this.metadata.set(competition.id, structuredClone(competition));
      this.revision++;
    }
  }
  private source(id: number): CompetitionDetail {
    const attack = id === 1001;
    if (![1001, 1002].includes(id))
      throw new Error(
        'Use sample competition 1001 (Attack) or 1002 (Fishing and Sailing).',
      );
    return {
      competition: {
        id,
        title: attack ? 'Vardorvis Attack week' : 'Vardorvis skilling weekend',
        sourceUrl: 'https://wiseoldman.net/competitions/' + id,
        skills: attack ? ['attack'] : skills.map(([id]) => id),
        startsAt: '2026-10-01T00:00:00Z',
        endsAt: '2026-10-08T00:00:00Z',
        importedAt: new Date().toISOString(),
      },
      participants: [
        {
          playerId: 1,
          displayName: 'KihiraVD',
          gains: attack
            ? { attack: String(12345678 + this.sourceVersion * 1250000) }
            : { ...zeroTotals(), fishing: '3200123', sailing: '4000000' },
        },
        {
          playerId: 2,
          displayName: 'Oakheart',
          gains: attack
            ? { attack: '6000000' }
            : { ...zeroTotals(), fishing: '1200000', sailing: '2500000' },
        },
        {
          playerId: 3,
          displayName: 'Iron Fern',
          gains: attack
            ? { attack: '0' }
            : { ...zeroTotals(), fishing: '0', sailing: '1000000' },
        },
        {
          playerId: 4,
          displayName: 'New recruit',
          gains: attack
            ? { attack: null }
            : { ...zeroTotals(), fishing: null, sailing: null },
        },
      ],
    };
  }
  /** Recompute from stored competition snapshots so refreshes replace rather than append XP. */
  private totals() {
    const totals = zeroTotals();
    for (const detail of this.stored.values())
      for (const row of detail.participants)
        for (const id of detail.competition.skills)
          if (row.gains[id] !== null && row.gains[id] !== undefined)
            totals[id] = String(BigInt(totals[id]) + BigInt(row.gains[id]!));
    return totals;
  }
  async tracker(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return structuredClone({
      revision: 'preview-' + this.revision,
      totals: this.totals(),
      podium: podiumFromParticipants(
        [...this.stored.values()].flatMap((d) => d.participants),
      ),
      events: [...this.stored.values()]
        .map((detail) => ({
          id: detail.competition.id,
          title: detail.competition.title,
          sourceUrl: detail.competition.sourceUrl,
          skills: detail.competition.skills,
          podium: podiumFromParticipants(detail.participants),
          gains: Object.fromEntries(
            detail.competition.skills.map((id) => {
              const known = detail.participants
                .map((row) => row.gains[id])
                .filter((value) => value !== null && value !== undefined);
              return [
                id,
                known.length
                  ? String(
                      known.reduce((sum, value) => sum + BigInt(value), 0n),
                    )
                  : detail.participants.length
                    ? null
                    : '0',
              ];
            }),
          ),
        }))
        .concat(
          [...this.metadata.values()]
            .filter((competition) => !this.stored.has(competition.id))
            .map((competition) => ({
              id: competition.id,
              title: competition.title,
              sourceUrl: competition.sourceUrl,
              skills: competitionScope(competition.metrics).skills,
              podium: [],
              gains: Object.fromEntries(
                competitionScope(competition.metrics).skills.map((skill) => [
                  skill,
                  null,
                ]),
              ),
            })),
        ),
    });
  }
  async load(
    skill: SkillId,
    competitionId: number | undefined,
    signal: AbortSignal,
  ): Promise<XpSnapshot> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const matching = [...this.stored.values()].filter((d) =>
      d.competition.skills.includes(skill),
    );
    const members = new Map<number, Member>();
    for (const detail of matching)
      for (const row of detail.participants) {
        const previous = members.get(row.playerId),
          gained = row.gains[skill] ?? null;
        members.set(row.playerId, {
          playerId: row.playerId,
          displayName: row.displayName,
          xp:
            gained === null
              ? (previous?.xp ?? null)
              : String(BigInt(previous?.xp ?? '0') + BigInt(gained)),
        });
      }
    const detail =
      matching.find((d) => d.competition.id === competitionId) ?? matching[0];
    return structuredClone({
      overview: {
        revision: 'preview-' + this.revision,
        updatedAt: this.imports[0]?.importedAt ?? null,
        totals: this.totals(),
        competitions: [...this.stored.values()].map((d) => d.competition),
      },
      skill,
      members: [...members.values()],
      detail,
    });
  }
  async session(
    signal = new AbortController().signal,
  ): Promise<AdminSession | null> {
    if (this.getSession) return this.getSession(signal);
    return {
      csrfToken: 'preview-only',
      displayName: 'Preview admin',
      username: 'preview-admin',
      role: 'admin',
      mustChangePassword: false,
    };
  }
  async preview(
    url: string,
    _csrf: string,
    signal: AbortSignal,
  ): Promise<ImportPreview> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const detail = this.source(competitionUrl(url).id),
      before = this.totals();
    const previous = this.stored.get(detail.competition.id);
    const preview: ImportPreview = {
      ...detail,
      previewToken: crypto.randomUUID(),
      expectedRevision: 'preview-' + this.revision,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      changes: detail.competition.skills.map((skill) => {
        const sum = (rows: CompetitionDetail['participants']) =>
          rows.reduce((total, p) => total + BigInt(p.gains[skill] ?? '0'), 0n);
        const change =
          sum(detail.participants) - sum(previous?.participants ?? []);
        return {
          skill,
          before: before[skill],
          after: String(BigInt(before[skill]) + change),
          change: String(change),
        };
      }),
      warnings: ['Sample data only. No Wise Old Man or clan data is changed.'],
    };
    this.previews.set(preview.previewToken, preview);
    return structuredClone(preview);
  }
  async apply(
    preview: ImportPreview,
    _csrf: string,
    requestKey: string,
    signal: AbortSignal,
  ): Promise<ApplyResult> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Resolve known retries before checking the revision advanced by the original apply.
    const receipt = this.receipts.get(requestKey);
    if (receipt) {
      if (receipt.token !== preview.previewToken) throw new XpRequestError(409);
      return receipt.result;
    }
    const current = this.previews.get(preview.previewToken);
    if (
      !current ||
      current.expectedRevision !== 'preview-' + this.revision ||
      Date.parse(current.expiresAt) <= Date.now()
    )
      throw new XpRequestError(409);
    // Fixture outcome tracks aggregate changes; a production reconciler must also track rows.
    const outcome =
      current.changes.some((c) => BigInt(c.change) !== 0n) ||
      !this.stored.has(current.competition.id)
        ? 'applied'
        : 'unchanged';
    this.stored.set(
      current.competition.id,
      structuredClone({
        competition: current.competition,
        participants: current.participants,
      }),
    );
    if (outcome === 'applied') this.revision++;
    const result = { outcome, revision: 'preview-' + this.revision } as const;
    this.receipts.set(requestKey, { token: current.previewToken, result });
    this.imports.unshift({
      id: crypto.randomUUID(),
      competitionId: current.competition.id,
      title: current.competition.title,
      actorName: 'Preview admin',
      importedAt: new Date().toISOString(),
      outcome,
      changes: current.changes,
    });
    return result;
  }
  async history(
    signal = new AbortController().signal,
    cursor?: string,
  ): Promise<ImportHistoryPage> {
    signal.throwIfAborted();
    if (this.getSession) {
      const session = await this.getSession(signal);
      if (!session) throw new XpRequestError(401);
      if (session.mustChangePassword) throw new XpRequestError(403);
    }
    signal.throwIfAborted();
    // Each append counts, including unchanged imports whose tracker revision stays put.
    const revision = 'preview-xp-history-' + this.imports.length;
    const match = cursor ? /^(\d+):(.*)$/u.exec(cursor) : null;
    if (
      cursor &&
      (!match ||
        match[2] !== revision ||
        !Number.isSafeInteger(Number(match[1])))
    )
      throw new XpRequestError(409);
    const start = match ? Number(match[1]) : 0;
    return structuredClone({
      revision,
      pageCursor: start + ':' + revision,
      nextCursor:
        start + 20 < this.imports.length ? start + 20 + ':' + revision : null,
      imports: this.imports.slice(start, start + 20),
    });
  }
  advance() {
    this.sourceVersion++;
  }
  async samples() {
    for (const id of [1001, 1002]) {
      const preview = await this.preview(
        'https://wiseoldman.net/competitions/' + id,
        'preview-only',
        new AbortController().signal,
      );
      await this.apply(
        preview,
        'preview-only',
        crypto.randomUUID(),
        new AbortController().signal,
      );
    }
  }
}

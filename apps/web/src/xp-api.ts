/** Future XP/auth HTTP contracts with validated snapshots and private import operations. */
import { parseTracker } from './xp-tracker.ts';
import {
  amount,
  competitionUrl,
  identity,
  list,
  object,
  parseChanges,
  parseCompetition,
  parseParticipants,
  parsePreview,
  skill,
  skills,
  text,
  timestamp,
  unique,
  zeroTotals,
  type AdminSession,
  type ApplyResult,
  type ImportEntry,
  type ImportPreview,
  type Member,
  type SkillId,
  type XpClient,
  type XpSnapshot,
} from './xp-model.ts';

export class XpRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      status === 401
        ? 'Sign in with the admin password to import competitions.'
        : status === 403
          ? 'Your account is not allowed to import competitions.'
          : status === 409
            ? 'This preview is out of date. Preview the competition again.'
            : status === 429
              ? 'The source is rate limited. Try again shortly.'
              : [404, 501, 503].includes(status)
                ? 'The XP service is not available yet.'
                : 'Could not refresh XP. Your last successful results are preserved.',
    );
    this.status = status;
  }
}
interface Cached {
  data: unknown;
  etag: string | null;
}
export class LiveXpClient implements XpClient {
  private cache = new Map<string, Cached>();
  private request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request.bind(globalThis);
  }
  private async json(
    path: string,
    signal: AbortSignal,
    options: RequestInit = {},
    staged?: Map<string, Cached>,
  ): Promise<unknown> {
    const cached = staged ? this.cache.get(path) : undefined;
    const response = await this.request(path, {
      ...options,
      signal,
      credentials: 'same-origin',
      cache: staged ? 'no-cache' : 'no-store',
      headers: {
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        ...options.headers,
      },
    });
    if (response.status === 304 && cached) {
      staged?.set(path, cached);
      return cached.data;
    }
    if (!response.ok) throw new XpRequestError(response.status);
    const data: unknown = await response.json();
    staged?.set(path, { data, etag: response.headers.get('ETag') });
    return data;
  }
  async tracker(signal: AbortSignal) {
    const staged = new Map<string, Cached>();
    const result = parseTracker(
      await this.json('/api/v1/xp/tracker', signal, {}, staged),
    );
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const [path, entry] of staged) this.cache.set(path, entry);
    return result;
  }
  async load(
    selected: SkillId,
    competitionId: number | undefined,
    signal: AbortSignal,
  ): Promise<XpSnapshot> {
    // Stage conditional responses until totals, members and competition share one revision.
    const staged = new Map<string, Cached>();
    const [skillValue, competitionValue] = await Promise.all([
      this.json('/api/v1/xp/skills', signal, {}, staged),
      this.json('/api/v1/xp/competitions', signal, {}, staged),
    ]);
    const summary = object(skillValue),
      competitionsData = object(competitionValue),
      revision = text(summary.revision);
    const updatedAt =
      summary.updatedAt === null ? null : timestamp(summary.updatedAt);
    if (competitionsData.revision !== revision)
      throw new Error('Inconsistent XP revision.');
    const rows = list(summary.skills).map((value) => {
      const row = object(value);
      return { skill: skill(row.skill), xp: amount(row.xp) };
    });
    unique(rows.map((row) => row.skill));
    if (rows.length !== skills.length)
      throw new Error('Incomplete skill totals.');
    const totals = zeroTotals();
    for (const row of rows) totals[row.skill] = row.xp;
    const competitions = list(competitionsData.competitions).map(
      parseCompetition,
    );
    unique(competitions.map((c) => c.id));
    const chosen =
      competitions.find(
        (c) => c.id === competitionId && c.skills.includes(selected),
      ) ?? competitions.find((c) => c.skills.includes(selected));
    const [memberValue, detailValue] = await Promise.all([
      this.json(
        '/api/v1/xp/skills/' + selected + '/members',
        signal,
        {},
        staged,
      ),
      chosen
        ? this.json('/api/v1/xp/competitions/' + chosen.id, signal, {}, staged)
        : undefined,
    ]);
    const memberData = object(memberValue);
    if (memberData.revision !== revision || memberData.skill !== selected)
      throw new Error('Inconsistent member XP.');
    const members: Member[] = list(memberData.members).map((value) => {
      const row = object(value);
      return {
        playerId: identity(row.playerId),
        displayName: text(row.displayName),
        xp: row.xp === null ? null : amount(row.xp),
      };
    });
    unique(members.map((row) => row.playerId));
    let detail: XpSnapshot['detail'];
    if (chosen) {
      const d = object(detailValue),
        competition = parseCompetition(d.competition);
      if (
        d.revision !== revision ||
        competition.id !== chosen.id ||
        JSON.stringify(competition) !== JSON.stringify(chosen)
      )
        throw new Error('Inconsistent competition XP.');
      detail = {
        competition,
        participants: parseParticipants(d.participants, competition.skills),
      };
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // Commit ETags only after all selected views agree on one complete projection.
    for (const [path, entry] of staged) this.cache.set(path, entry);
    return {
      overview: {
        revision,
        updatedAt,
        totals,
        competitions,
      },
      skill: selected,
      members,
      detail,
    };
  }
  async session(signal: AbortSignal): Promise<AdminSession | null> {
    try {
      const value = object(await this.json('/api/v1/auth/session', signal));
      if (value.authenticated === false) return null;
      if (value.authenticated !== true)
        throw new Error('Invalid admin session.');
      if (
        value.development !== undefined &&
        typeof value.development !== 'boolean'
      )
        throw new Error('Invalid admin session mode.');
      return {
        csrfToken: text(value.csrfToken),
        displayName: text(value.displayName),
        ...(value.development === true ? { development: true } : {}),
      };
    } catch (error) {
      if (error instanceof XpRequestError && error.status === 401) return null;
      throw error;
    }
  }
  async preview(
    url: string,
    csrf: string,
    signal: AbortSignal,
  ): Promise<ImportPreview> {
    const source = competitionUrl(url);
    const preview = parsePreview(
      await this.json('/api/v1/admin/xp/imports/preview', signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ competitionUrl: source.url }),
      }),
    );
    if (preview.competition.id !== source.id)
      throw new Error('The preview does not match the requested competition.');
    return preview;
  }
  /** Apply the server's preview token; never submit browser-calculated totals as authority. */
  async apply(
    preview: ImportPreview,
    csrf: string,
    requestKey: string,
    signal: AbortSignal,
    acknowledgeCorrections = false,
  ): Promise<ApplyResult> {
    const value = object(
      await this.json('/api/v1/admin/xp/imports', signal, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': requestKey,
        },
        body: JSON.stringify({
          previewToken: preview.previewToken,
          expectedRevision: preview.expectedRevision,
          acknowledgeCorrections,
        }),
      }),
    );
    if (!['applied', 'unchanged'].includes(text(value.outcome)))
      throw new Error('Invalid import outcome.');
    return {
      outcome: value.outcome as ApplyResult['outcome'],
      revision: text(value.revision),
    };
  }
  async history(signal: AbortSignal): Promise<ImportEntry[]> {
    const value = object(await this.json('/api/v1/admin/xp/imports', signal));
    const rows = list(value.imports).map((entry) => {
      const row = object(entry),
        outcome = text(row.outcome);
      if (!['applied', 'unchanged'].includes(outcome))
        throw new Error('Invalid import outcome.');
      return {
        id: text(row.id),
        competitionId: identity(row.competitionId),
        title: text(row.title),
        actorName: text(row.actorName),
        importedAt: timestamp(row.importedAt),
        outcome: outcome as ImportEntry['outcome'],
        changes: parseChanges(row.changes),
      };
    });
    unique(rows.map((row) => row.id));
    return rows;
  }
}

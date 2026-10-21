/** Private competition import transport is loaded only when staff use it. */
import {
  competitionAmount,
  competitionUsesPages,
  parseCustomCompetitionMetric,
  parseCompetitionDefinitions,
  parseCompetitionStandings,
  type CustomCompetitionMetric,
  type CompetitionMetricResolution,
  type CompetitionLifecycle,
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
} from './xp-model.ts';
import {
  CompetitionRequestError,
  parseWomCompetition,
  type CompetitionImportPreview,
} from './competition-api.ts';
export class UnknownMetricRequestError extends CompetitionRequestError {
  readonly resolution: CompetitionMetricResolution;
  constructor(resolution: CompetitionMetricResolution) {
    super(422, 'Choose how to record the unknown competition metrics.');
    this.resolution = resolution;
  }
}
export function parseMetricResolution(
  value: unknown,
): CompetitionMetricResolution {
  const row = object(value);
  const source = competitionUrl(text(row.sourceUrl));
  const id = identity(row.id);
  const keys = list(row.metrics).map((d) => text(object(d).metric));
  const unknownMetrics = list(row.unknownMetrics).map(text);
  unique(keys);
  unique(unknownMetrics);
  const resolutionToken = text(row.resolutionToken),
    revision = text(row.revision);
  const startsAt = timestamp(row.startsAt),
    endsAt = timestamp(row.endsAt);
  if (
    source.id !== id ||
    !keys.length ||
    keys.length > 64 ||
    !unknownMetrics.length ||
    keys.some((key) => !/^[a-z][a-z0-9_]{0,79}$/u.test(key)) ||
    unknownMetrics.some((key) => !keys.includes(key)) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(resolutionToken) ||
    !/^metrics-[1-9][0-9]*$/u.test(revision) ||
    startsAt >= endsAt
  )
    throw new Error('Invalid metric resolution prompt.');
  const pages = list(row.pages).map((p) => ({
    id: text(object(p).id),
    name: text(object(p).name),
  }));
  unique(pages.map((p) => p.id));
  if (pages.length > 2000) throw new Error('Invalid metric page choices.');
  return {
    id,
    title: text(row.title),
    sourceUrl: source.url,
    metrics: parseCompetitionDefinitions(row.metrics, keys),
    startsAt,
    endsAt,
    unknownMetrics,
    resolutionToken,
    revision,
    expiresAt: timestamp(row.expiresAt),
    pages,
  };
}
async function json(
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
  if (
    response.status === 422 &&
    path === '/api/v1/admin/competitions/preview' &&
    object(value).code === 'UNKNOWN_WOM_METRICS'
  )
    throw new UnknownMetricRequestError(
      parseMetricResolution(object(value).resolution),
    );
  if (!response.ok)
    throw new CompetitionRequestError(
      response.status,
      typeof object(value).error === 'string'
        ? String(object(value).error)
        : 'Competition request failed.',
    );
  return value;
}
export async function previewCompetition(
  url: string,
  csrf: string,
  signal: AbortSignal,
  pageIds?: string[],
) {
  const p = object(
    await json('/api/v1/admin/competitions/preview', signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        competitionUrl: competitionUrl(url).url,
        ...(pageIds ? { pageIds } : {}),
      }),
    }).catch((error: unknown) => {
      if (
        error instanceof UnknownMetricRequestError &&
        error.resolution.id !== competitionUrl(url).id
      )
        throw new Error(
          'Metric prompt does not match the requested competition.',
        );
      throw error;
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
      'update-schedule',
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
        : competitionAmount(r.gained),
    };
  });
  unique(participants.map((r) => r.playerId));
  const standings =
    p.standings === undefined
      ? undefined
      : parseCompetitionStandings(
          p.standings,
          competition.metrics,
          competition.metricDefinitions,
        );
  if (p.lifecycle !== 'finished' && (participants.length || standings?.length))
    throw new Error('Live imports must contain metadata only.');
  const metadataOnly =
    !competitionUsesPages(competition.metrics, competition.metricDefinitions) &&
    p.lifecycle !== 'finished';
  if (
    metadataOnly !== (p.action === 'import-metadata') ||
    (metadataOnly &&
      (list(p.pageIds).length ||
        list(p.pages).length ||
        list(p.changes).length ||
        p.scheduleStartsAt !== null))
  )
    throw new Error('Invalid metadata-only competition preview.');
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
    ...(standings === undefined ? {} : { standings }),
  };
}
export async function saveCompetitionMetrics(
  resolution: CompetitionMetricResolution,
  definitions: CustomCompetitionMetric[],
  key: string,
  csrf: string,
  signal: AbortSignal,
) {
  const result = object(
    await json('/api/v1/admin/competitions/metrics', signal, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        resolutionToken: resolution.resolutionToken,
        expectedRevision: resolution.revision,
        definitions: definitions.map(parseCustomCompetitionMetric),
      }),
    }),
  );
  if (
    !/^metrics-[1-9][0-9]*$/u.test(text(result.revision)) ||
    JSON.stringify(list(result.savedMetrics).map(text).sort()) !==
      JSON.stringify(definitions.map((d) => d.metric).sort())
  )
    throw new Error(
      'Unexpected metric save receipt. Retry the same choices to confirm.',
    );
}
export async function applyCompetitionImport(
  p: CompetitionImportPreview,
  csrf: string,
  key: string,
  acknowledged: boolean,
  signal: AbortSignal,
) {
  const r = object(
    await json('/api/v1/admin/competitions/imports', signal, {
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

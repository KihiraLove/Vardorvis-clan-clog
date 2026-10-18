/** Detailed XP/import simulation contracts; never included in production. */
import {
  amount,
  competitionUrl,
  identity,
  list,
  object,
  parseChanges,
  skill,
  text,
  timestamp,
  unique,
  type Gains,
  type ImportChange,
  type SkillId,
  type Xp,
} from '../../src/xp-model.ts';
export interface Competition {
  id: number;
  title: string;
  sourceUrl: string;
  skills: SkillId[];
  startsAt: string;
  endsAt: string;
  importedAt: string;
}
export interface Participant {
  playerId: number;
  displayName: string;
  gains: Gains;
}
export interface CompetitionDetail {
  competition: Competition;
  participants: Participant[];
}
export interface XpOverview {
  revision: string;
  updatedAt: string | null;
  totals: Record<SkillId, Xp>;
  competitions: Competition[];
}
export interface Member {
  playerId: number;
  displayName: string;
  xp: Xp | null;
}
export interface XpSnapshot {
  overview: XpOverview;
  skill: SkillId;
  members: Member[];
  detail?: CompetitionDetail | undefined;
}
export interface ImportPreview extends CompetitionDetail {
  previewToken: string;
  expectedRevision: string;
  expiresAt: string;
  changes: ImportChange[];
  warnings: string[];
}
export interface ImportEntry {
  id: string;
  competitionId: number;
  title: string;
  actorName: string;
  importedAt: string;
  outcome: 'applied' | 'unchanged';
  changes: ImportChange[];
}
export interface ImportHistoryPage {
  revision: string;
  pageCursor: string;
  nextCursor: string | null;
  imports: ImportEntry[];
}
export function parseImportHistory(input: unknown): ImportHistoryPage {
  const value = object(input);
  const imports = list(value.imports).map((entry) => {
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
  unique(imports.map((row) => row.id));
  if (imports.length > 20)
    throw new Error('XP history page exceeds supported size.');
  return {
    revision: text(value.revision),
    pageCursor: text(value.pageCursor),
    nextCursor: value.nextCursor === null ? null : text(value.nextCursor),
    imports,
  };
}
export interface ApplyResult {
  outcome: 'applied' | 'unchanged';
  revision: string;
}
export function compareXp(a: Xp | null, b: Xp | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0;
}
/** Extract a positive WOM identity and discard query/fragment data from the canonical URL. */
/** Validate source identity, metric uniqueness and a strictly increasing competition period. */
export function parseCompetition(value: unknown): Competition {
  const c = object(value);
  const source = competitionUrl(text(c.sourceUrl));
  const id = identity(c.id);
  if (source.id !== id) throw new Error('Competition link identity mismatch.');
  const ids = list(c.skills).map(skill);
  unique(ids);
  if (!ids.length) throw new Error('An event needs supported skills.');
  const startsAt = timestamp(c.startsAt),
    endsAt = timestamp(c.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt))
    throw new Error('Invalid competition period.');
  return {
    id,
    title: text(c.title),
    sourceUrl: source.url,
    skills: ids,
    startsAt,
    endsAt,
    importedAt: timestamp(c.importedAt),
  };
}
/** Require every declared metric per participant while preserving explicit unavailable values. */
export function parseParticipants(
  value: unknown,
  ids: SkillId[],
): Participant[] {
  const rows = list(value).map((entry) => {
    const p = object(entry),
      gains = object(p.gains);
    if (Object.keys(gains).some((key) => !ids.includes(skill(key))))
      throw new Error('Unexpected competition metric.');
    return {
      playerId: identity(p.playerId),
      displayName: text(p.displayName),
      gains: Object.fromEntries(
        ids.map((id) => [id, gains[id] === null ? null : amount(gains[id])]),
      ) as Gains,
    };
  });
  unique(rows.map((p) => p.playerId));
  return rows;
}
/** Recalculate each delta with BigInt before trusting a preview or history response. */
/** An import preview combines complete participant data with an expiring revision-bound token. */
export function parsePreview(value: unknown): ImportPreview {
  const p = object(value),
    competition = parseCompetition(p.competition);
  const changes = parseChanges(p.changes);
  if (
    changes.length !== competition.skills.length ||
    changes.some((c) => !competition.skills.includes(c.skill))
  )
    throw new Error('Incomplete import changes.');
  return {
    competition,
    participants: parseParticipants(p.participants, competition.skills),
    previewToken: text(p.previewToken),
    expectedRevision: text(p.expectedRevision),
    expiresAt: timestamp(p.expiresAt),
    changes,
    warnings: list(p.warnings).map(text),
  };
}

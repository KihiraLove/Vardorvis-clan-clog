import type {
  CompetitionImportAction,
  CompetitionLifecycle,
  WomCompetition,
  CompetitionStanding,
} from '@clog/domain';
import type { XpChange, XpParticipant, XpSnapshot, Skill } from './xp-types.js';
export interface CompetitionSnapshot {
  competition: WomCompetition;
  skills: Skill[];
  lifecycle: CompetitionLifecycle;
  metricRevision?: string;
  // Only finished competitions may have results. Never retain the raw WOM response.
  results?: {
    participants: CompetitionStanding[];
    xp?: XpSnapshot;
  };
}
export interface CompetitionPreview {
  previewToken: string;
  expectedRevision: string;
  scheduleRevision: string;
  expiresAt: string;
  competition: WomCompetition;
  lifecycle: CompetitionLifecycle;
  pageIds: string[];
  pages: { id: string; name: string }[];
  action: CompetitionImportAction;
  scheduleStartsAt: string | null;
  participants: (
    XpParticipant | { playerId: number; displayName: string; gained: string }
  )[];
  changes: XpChange[];
  warnings: string[];
  standings?: CompetitionStanding[];
}
export interface CompetitionReceipt {
  outcome: 'applied' | 'unchanged';
  revision: string;
  scheduleId: string | null;
}

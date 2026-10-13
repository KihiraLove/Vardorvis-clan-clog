import type {
  CompetitionImportAction,
  CompetitionLifecycle,
  WomCompetition,
} from '@clog/domain';
import type { XpChange, XpParticipant, XpSnapshot, Skill } from './xp-types.js';
export interface CompetitionSnapshot {
  competition: WomCompetition;
  skills: Skill[];
  lifecycle: CompetitionLifecycle;
  // Only finished competitions may have results. Never retain the raw WOM response.
  results?: {
    participants: { playerId: number; displayName: string; gained: string }[];
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
}
export interface CompetitionReceipt {
  outcome: 'applied' | 'unchanged';
  revision: string;
  scheduleId: string | null;
}

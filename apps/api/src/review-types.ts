/** REVIEW-01 private response types. Public credits never expose these fields. */
export interface ReviewSubmission {
  id: string;
  version: number;
  source: 'discord' | 'manual' | 'runelite';
  itemId: number | null;
  rawItemText: string;
  /** Original RuneLite provenance, retained through canonical corrections. */
  gameItemId?: number;
  collectorName: string;
  collectedOn: string;
  dateSource: 'submission' | 'claim' | 'admin';
  submittedAt: string;
  proofUrl: string;
  screenshotPath?: string | null;
  chatMessage?: string;
  hardcore: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  /** Persisted staff note; unrelated to approve/reject/revoke audit reason. */
  reviewNote: string;
  /** Last decision/correction reason, retained for historical transparency. */
  reviewReason: string | null;
}
export interface ManualSubmissionInput {
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
  proofUrl?: string;
  approve: boolean;
  reason?: string;
}
export interface ReviewCorrection {
  itemId: number;
  collectorName: string;
  collectedOn: string;
  hardcore: boolean;
  reason: string;
}
export interface ReviewNote {
  note: string;
}
export interface ReviewAction {
  expectedVersion: number;
  action: 'approve' | 'reject' | 'revoke';
  reason?: string;
}
export interface ReviewAudit {
  id: string;
  actorName: string;
  at: string;
  action: 'create' | 'edit' | 'approve' | 'reject' | 'revoke';
  reason: string | null;
  before: ReviewSubmission;
  after: ReviewSubmission;
}
export interface ReviewStore {
  submissionFilters?(): Promise<import('@clog/domain').SubmissionFilters>;
  saveSubmissionFilters?(
    filterCollected: boolean,
    revision: string,
    actorId: string,
  ): Promise<import('@clog/domain').SubmissionFilters>;
  adminCatalog(): Promise<unknown>;
  createManual(
    fields: ManualSubmissionInput,
    actorId: string,
    actorName: string,
    requestKey: string,
    image?: import('./icon-storage.js').IconRecord,
  ): Promise<ReviewSubmission>;
  queue(
    status: 'pending' | 'reviewed',
    unmatched: boolean,
    limit: number,
    cursor?: string,
  ): Promise<{
    revision: string;
    submissions: ReviewSubmission[];
    nextCursor: string | null;
    pageCursor: string;
    filters?: import('@clog/domain').SubmissionFilters;
  }>;
  detail(
    id: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    submission: ReviewSubmission;
    audit: ReviewAudit[];
    auditRevision: string;
    auditCursor: string;
    nextAuditCursor: string | null;
  } | null>;
  mutate(
    id: string,
    expectedVersion: number,
    fields: ReviewCorrection | ReviewAction | ReviewNote,
    actorId: string,
    actorName: string,
  ): Promise<ReviewSubmission>;
}

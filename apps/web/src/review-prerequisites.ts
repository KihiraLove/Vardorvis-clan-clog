/** Pure explanations for every review action; UI and tests share one policy. */
export interface ReviewRequirements {
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  requestBusy: boolean;
  queueUnavailable: boolean;
  readError: boolean;
  claimDirty: boolean;
  noteDirty: boolean;
  activeItem: boolean;
  validProof: boolean;
  acknowledged: boolean;
  reasonProvided: boolean;
}

export type ReviewActionHint =
  | 'claim'
  | 'discardClaim'
  | 'note'
  | 'discardNote'
  | 'acknowledge'
  | 'approve'
  | 'reject'
  | 'revoke';

export function reviewBlockers(x: ReviewRequirements): Record<ReviewActionHint, string | null> {
  const common = x.requestBusy
    ? 'A review request is in progress. The result must be checked before another action.'
    : x.readError
      ? 'The saved submission version or audit could not be loaded. Reload the submission before continuing.'
      : x.queueUnavailable
        ? 'The submissions list is refreshing or unavailable. Reload before making changes.'
        : null;
  const editable = ['pending', 'approved'].includes(x.status);
  const write = common ?? (!editable ? 'Only pending or approved claims can be edited.' : null);
  const claim = write
    ?? (!x.claimDirty ? 'No claim corrections to save.' : null)
    ?? (!x.activeItem ? 'Select an active canonical item before saving corrections.' : null)
    ?? (x.status === 'approved' && !x.reasonProvided
      ? 'Enter an audit reason before changing an approved credit.' : null);
  const note = write ?? (!x.noteDirty ? 'No review note changes to save.' : null);
  const decision = common
    ?? (x.claimDirty ? 'Save or discard claim corrections before deciding.' : null);
  const proof = decision
    ?? (x.status !== 'pending' ? 'Only pending claims may be approved.' : null)
    ?? (!x.activeItem ? 'Select and save an active canonical item before approving.' : null)
    ?? (!x.validProof ? 'A valid proof link or saved screenshot is required for approval.' : null);
  const approve = proof
    ?? (!x.acknowledged ? 'Check the saved item, collector, date, world mode and proof, then tick the proof acknowledgement.' : null);
  const reject = decision
    ?? (x.status !== 'pending' ? 'Only pending claims may be rejected.' : null)
    ?? (!x.reasonProvided ? 'Enter a reason before rejecting a submission.' : null);
  const revoke = decision
    ?? (x.status !== 'approved' ? 'Only approved credits may be revoked.' : null)
    ?? (!x.reasonProvided ? 'Enter a reason before revoking a credit.' : null);
  return {
    claim,
    discardClaim: write ?? (!x.claimDirty ? 'There are no claim corrections to discard.' : null),
    note,
    discardNote: write ?? (!x.noteDirty ? 'There are no review note changes to discard.' : null),
    acknowledge: proof,
    approve,
    reject,
    revoke,
  };
}

/** Exhaustive control eligibility across normal/hardcore and decision states. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reviewBlockers,
  type ReviewRequirements,
} from './review-prerequisites.ts';

const ready: ReviewRequirements = {
  status: 'pending',
  requestBusy: false,
  queueUnavailable: false,
  readError: false,
  claimDirty: false,
  noteDirty: false,
  activeItem: true,
  validProof: true,
  acknowledged: true,
  reasonProvided: true,
};

test('saved ordinary/hardcore claims can be approved with proof acknowledgement', () => {
  for (const mode of ['ordinary', 'hardcore']) {
    assert.equal(reviewBlockers(ready).approve, null, mode);
    assert.equal(reviewBlockers(ready).acknowledge, null, mode);
    assert.equal(reviewBlockers({ ...ready, acknowledged: false }).approve?.includes('tick'), true);
    assert.equal(reviewBlockers({ ...ready, validProof: false }).approve?.includes('proof'), true);
    assert.equal(reviewBlockers({ ...ready, activeItem: false }).approve?.includes('canonical'), true);
    const dirty = reviewBlockers({ ...ready, claimDirty: true });
    assert.match(dirty.approve!, /Save or discard/u);
    assert.match(dirty.reject!, /Save or discard/u);
    assert.match(dirty.acknowledge!, /Save or discard/u);
  }
});

test('claim/note dirtiness and approved corrections have distinct prerequisites', () => {
  assert.match(reviewBlockers(ready).claim!, /No claim corrections/u);
  assert.match(reviewBlockers(ready).note!, /No review note changes/u);
  assert.equal(reviewBlockers({ ...ready, noteDirty: true }).note, null);
  assert.equal(reviewBlockers({ ...ready, noteDirty: true }).approve, null);
  assert.equal(reviewBlockers({ ...ready, claimDirty: true }).claim, null);
  assert.match(
    reviewBlockers({ ...ready, status: 'approved', claimDirty: true, reasonProvided: false }).claim!,
    /Enter an audit reason/u,
  );
  assert.equal(
    reviewBlockers({ ...ready, status: 'approved', claimDirty: true }).claim,
    null,
  );
  assert.match(
    reviewBlockers({ ...ready, status: 'pending', claimDirty: true, activeItem: false }).claim!,
    /active canonical item/u,
  );
});

test('reject and revoke need a decision reason but do not require approval proof', () => {
  assert.equal(reviewBlockers({ ...ready, validProof: false, acknowledged: false }).reject, null);
  assert.match(reviewBlockers({ ...ready, reasonProvided: false }).reject!, /reason/u);
  assert.equal(reviewBlockers({ ...ready, status: 'approved' }).revoke, null);
  assert.match(reviewBlockers({ ...ready, status: 'approved', reasonProvided: false }).revoke!, /reason/u);
  assert.match(reviewBlockers(ready).revoke!, /Only approved/u);
  assert.match(reviewBlockers({ ...ready, status: 'rejected' }).reject!, /Only pending/u);
});

test('pending requests, stale reads and lost queue access block all mutations with explicit reasons', () => {
  for (const [field, phrase] of [
    ['requestBusy', 'in progress'],
    ['readError', 'Reload the submission'],
    ['queueUnavailable', 'refreshing or unavailable'],
  ] as const) {
    const input = { ...ready, [field]: true, claimDirty: true, noteDirty: true };
    const b = reviewBlockers(input);
    for (const action of ['approve', 'reject', 'note', 'claim', 'revoke'] as const)
      assert.match(b[action]!, new RegExp(phrase, 'u'), action);
  }
  assert.match(reviewBlockers({ ...ready, status: 'revoked', noteDirty: true }).note!, /Only pending or approved/u);
});

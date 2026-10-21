import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityRange } from './activity-range.ts';

test('activity ranges omit shared years and offsets, including future years and UTC', () => {
  assert.deepEqual(
    activityRange('2030-09-01T09:00Z', '2030-09-02T11:05Z', 'UTC'),
    { start: '01/Sep 09:00', end: '02/Sep 11:05 +00:00' },
  );
  assert.deepEqual(
    activityRange(
      '2026-10-21T17:00Z',
      '2026-10-22T19:00Z',
      'Europe/Copenhagen',
    ),
    { start: '21/Oct 19:00', end: '22/Oct 21:00 +02:00' },
  );
});
test('activity ranges include both years across New Year and both offsets across DST', () => {
  assert.deepEqual(
    activityRange(
      '2026-12-31T22:00Z',
      '2027-01-01T00:00Z',
      'Europe/Copenhagen',
    ),
    { start: '31/Dec/26 23:00', end: '01/Jan/27 01:00 +01:00' },
  );
  assert.deepEqual(
    activityRange(
      '2026-10-24T17:00Z',
      '2026-10-25T18:00Z',
      'Europe/Copenhagen',
    ),
    { start: '24/Oct 19:00 +02:00', end: '25/Oct 19:00 +01:00' },
  );
  assert.deepEqual(
    activityRange(
      '2026-10-24T17:00Z',
      '2027-01-01T00:00Z',
      'Europe/Copenhagen',
    ),
    { start: '24/Oct/26 19:00 +02:00', end: '01/Jan/27 01:00 +01:00' },
  );
});
test('activity years use local dates and offsets preserve fractional hours', () => {
  assert.deepEqual(
    activityRange('2026-12-31T19:00Z', '2026-12-31T22:00Z', 'Asia/Kolkata'),
    { start: '01/Jan 00:30', end: '01/Jan 03:30 +05:30' },
  );
});

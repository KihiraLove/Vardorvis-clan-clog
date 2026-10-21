import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseCollectionScheduleInput,
  parseSchedulingState,
  scheduledItemOpen,
  parsePermanentPageIds,
} from './scheduling.js';
const schedule = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Boss week',
  startsAt: '2026-10-12T10:00:00.000Z',
  endsAt: '2026-10-12T12:00:00.000Z',
  pageIds: ['page-a'],
};
test('windows have exact boundaries, overlap as a union and admit any associated page', () => {
  const state = {
    enabled: true,
    schedules: [
      schedule,
      {
        ...schedule,
        id: '00000000-0000-4000-8000-000000000002',
        startsAt: '2026-10-12T11:00:00.000Z',
        endsAt: '2026-10-12T13:00:00.000Z',
        pageIds: ['page-a', 'page-b'],
      },
    ],
  };
  assert.equal(
    scheduledItemOpen(state, ['page-a'], '2026-10-12T09:59:59.999Z'),
    false,
  );
  assert.equal(
    scheduledItemOpen(state, ['page-a'], '2026-10-12T10:00:00.000Z'),
    true,
  );
  assert.equal(
    scheduledItemOpen(
      state,
      ['page-closed', 'page-a'],
      '2026-10-12T12:30:00.000Z',
    ),
    true,
  );
  assert.equal(
    scheduledItemOpen(state, ['page-b'], '2026-10-12T10:30:00.000Z'),
    false,
  );
  assert.equal(
    scheduledItemOpen(state, ['page-b'], '2026-10-12T11:30:00.000Z'),
    true,
  );
  assert.equal(
    scheduledItemOpen(state, ['page-a'], '2026-10-12T13:00:00.000Z'),
    false,
  );
  assert.equal(scheduledItemOpen(state, [], '2026-10-12T11:30:00.000Z'), false);
  assert.equal(
    scheduledItemOpen(
      { ...state, enabled: false },
      [],
      '2026-10-12T11:30:00.000Z',
    ),
    true,
  );
  assert.equal(
    scheduledItemOpen(
      { enabled: true, schedules: [] },
      ['page-a'],
      '2026-10-12T11:30:00.000Z',
    ),
    false,
  );
});
test('schedule validation rejects normalized invalid dates, reversed windows and malformed page sets', () => {
  const { id, ...input } = schedule;
  assert.deepEqual(
    parseCollectionScheduleInput({
      ...input,
      title: ' Boss week ',
      pageIds: ['page-b', 'page-a'],
    }),
    { ...input, title: 'Boss week', pageIds: ['page-a', 'page-b'] },
  );
  for (const bad of [
    { ...input, startsAt: '2026-02-30T10:00:00.000Z' },
    { ...input, startsAt: '2026-10-12T10:00' },
    { ...input, startsAt: '2026-10-12T10:00:00+02:00' },
    { ...input, endsAt: input.startsAt },
    { ...input, endsAt: '2026-10-12T09:00:00.000Z' },
    { ...input, pageIds: [] },
    { ...input, pageIds: ['page-a', 'page-a'] },
    { ...input, pageIds: [1] },
    { ...input, title: 'bad\nname' },
    { ...input, unexpected: true },
  ])
    assert.throws(() => parseCollectionScheduleInput(bad));
  const state = {
    revision: 'schedules-1',
    enabled: false,
    schedules: [{ id, ...input }],
    permanentlyOpenPageIds: [],
  };
  assert.deepEqual(parseSchedulingState(state), state);
  assert.throws(() =>
    parseSchedulingState({ ...state, schedules: [schedule, schedule] }),
  );
  assert.throws(() => parseSchedulingState({ ...state, enabled: 'false' }));
});

test('legacy permanent selections cannot open pages and old payloads remain readable', () => {
  const state = {
    enabled: true,
    schedules: [schedule],
    permanentlyOpenPageIds: ['page-b'],
  };
  for (const now of [
    '2026-10-12T09:00:00.000Z',
    '2026-10-12T11:00:00.000Z',
    '2026-10-12T13:00:00.000Z',
  ]) {
    assert.equal(scheduledItemOpen(state, ['page-b'], now), false);
    assert.equal(scheduledItemOpen(state, ['other', 'page-b'], now), false);
    assert.equal(scheduledItemOpen(state, ['unrelated'], now), false);
  }
  assert.deepEqual(parsePermanentPageIds(['page-b', 'page-a']), [
    'page-a',
    'page-b',
  ]);
  assert.deepEqual(parsePermanentPageIds([]), []);
  for (const bad of [
    null,
    'page-a',
    [1],
    [''],
    [' page-a'],
    ['page-a', 'page-a'],
    ['a'.repeat(101)],
    Array.from({ length: 2001 }, (_, i) => 'page-' + i),
  ])
    assert.throws(() => parsePermanentPageIds(bad));
  const parsed = parseSchedulingState({
    revision: 'schedules-1',
    enabled: false,
    schedules: [],
  });
  assert.deepEqual(parsed.permanentlyOpenPageIds, []);
  assert.throws(() =>
    parseSchedulingState({ ...parsed, permanentlyOpenPageIds: null }),
  );
});

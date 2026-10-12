import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedCollectionPageMessage } from '@clog/domain';
import { localScheduleInput, localScheduleToUtc } from './schedule-time.ts';
import { LiveAdminClient, AdminRequestError } from './admin-api.ts';
import { PreviewAdminClient } from './preview/admin.ts';
const signal = () => new AbortController().signal;
test('local input uses the date-specific timezone offset and rejects nonexistent daylight saving times', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Copenhagen';
  try {
    assert.equal(
      localScheduleToUtc('2026-10-12T09:00'),
      '2026-10-12T07:00:00.000Z',
    );
    assert.equal(
      localScheduleToUtc('2026-11-02T09:00'),
      '2026-11-02T08:00:00.000Z',
    );
    assert.equal(
      localScheduleInput('2026-10-12T07:00:00.000Z'),
      '2026-10-12T09:00:00',
    );
    assert.throws(
      () => localScheduleToUtc('2026-03-29T02:30'),
      /does not exist/u,
    );
    assert.equal(
      localScheduleToUtc('2026-10-25T02:30'),
      '2026-10-25T00:30:00.000Z',
    );
    assert.throws(() => localScheduleToUtc('2026-02-30T10:00'));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
test('schedule adapters send UTC, revisions and CSRF; closed submissions do not become auth failures', async () => {
  const input = {
    title: 'Boss week',
    startsAt: '2026-10-12T10:00:00.000Z',
    endsAt: '2026-10-12T12:00:00.000Z',
    pageIds: ['page-a'],
  };
  const id = '00000000-0000-4000-8000-000000000001';
  const state = {
    revision: 'schedules-2',
    enabled: false,
    schedules: [{ id, ...input }],
  };
  const client = new LiveAdminClient(async (path, options) => {
    assert.equal(path, '/api/v1/admin/schedules');
    assert.equal(options?.method, 'POST');
    assert.equal(
      (options.headers as Record<string, string>)['X-CSRF-Token'],
      'csrf',
    );
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(options.body)), {
      expectedRevision: 'schedules-1',
      ...input,
    });
    return Response.json(state);
  });
  assert.deepEqual(
    await client.saveSchedule(input, 'schedules-1', 'csrf', signal()),
    state,
  );
  await assert.rejects(
    new LiveAdminClient(async () => Response.json(state)).deleteSchedule(
      id,
      'schedules-1',
      'csrf',
      signal(),
    ),
    /Unexpected/u,
  );
  await assert.rejects(
    new LiveAdminClient(async () =>
      Response.json({ error: closedCollectionPageMessage }, { status: 403 }),
    ).scheduling(signal()),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof AdminRequestError) &&
      error.message === closedCollectionPageMessage,
  );
});
test('preview preserves overlapping schedules, stale writes and disabled normal intake', async () => {
  const client = new PreviewAdminClient();
  let state = await client.scheduling(signal());
  const catalog = await client.catalog(signal()),
    page = catalog.pages[0]!;
  const input = {
    title: 'Future window',
    startsAt: '2090-01-01T10:00:00.000Z',
    endsAt: '2090-01-01T12:00:00.000Z',
    pageIds: [page.id],
  };
  state = await client.saveSchedule(input, state.revision, 'csrf', signal());
  const initialRevision = state.revision;
  state = await client.saveSchedule(
    { ...input, title: 'Overlap' },
    state.revision,
    'csrf',
    signal(),
  );
  assert.equal(state.schedules.length, 2);
  await assert.rejects(
    client.setSchedulingEnabled(true, initialRevision, 'csrf', signal()),
    { status: 409 },
  );
  state = await client.setSchedulingEnabled(
    true,
    state.revision,
    'csrf',
    signal(),
  );
  await assert.rejects(
    client.addManual(
      {
        itemId: page.itemIds[0]!,
        collectorName: 'Player',
        collectedOn: '2026-10-12',
        hardcore: false,
        approve: false,
      },
      'closed',
      'csrf',
      signal(),
    ),
    /Submissions are closed/u,
  );
  state = await client.setSchedulingEnabled(
    false,
    state.revision,
    'csrf',
    signal(),
  );
  assert.equal(
    (
      await client.addManual(
        {
          itemId: page.itemIds[0]!,
          collectorName: 'Player',
          collectedOn: '2026-10-12',
          hardcore: false,
          approve: false,
        },
        'open',
        'csrf',
        signal(),
      )
    ).status,
    'pending',
  );
  state.schedules[0]!.pageIds.push('injected');
  assert.equal(
    (await client.scheduling(signal())).schedules[0]!.pageIds.length,
    1,
  );
});

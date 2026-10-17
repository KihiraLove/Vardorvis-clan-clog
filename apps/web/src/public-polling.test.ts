import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PublicPoller,
  publicRead,
  reportPublicFailure,
  type PollEnvironment,
} from './public-polling.ts';
import { nextActivityBoundary } from './activity-clock.ts';
import type { WomCompetition } from '@clog/domain';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function environment() {
  let visible = true;
  const listeners = new Set<() => void>();
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let id = 0;
  type Timer = ReturnType<typeof setTimeout>;
  const env: PollEnvironment = {
    visible: () => visible,
    listen: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    interval: (callback, ms) => {
      assert.equal(ms, 25000);
      intervals.set(++id, callback);
      return id as unknown as Timer;
    },
    timeout: (callback, ms) => {
      assert.equal(ms, 10000);
      timeouts.set(++id, callback);
      return id as unknown as Timer;
    },
    clearInterval: (timer) => {
      intervals.delete(timer as unknown as number);
    },
    clearTimeout: (timer) => {
      timeouts.delete(timer as unknown as number);
    },
  };
  return {
    env,
    intervals,
    timeouts,
    listeners,
    visibility(next: boolean) {
      visible = next;
      for (const callback of listeners) callback();
    },
  };
}
test('one cadence shares independent resources, suspends hidden work, and refreshes once on return', async () => {
  const state = environment(),
    poller = new PublicPoller(state.env);
  const reads = [0, 0, 0];
  const subscriptions = reads.map((_, i) =>
    poller.subscribe(async () => {
      reads[i]!++;
    }),
  );
  await flush();
  assert.deepEqual(reads, [1, 1, 1]);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.listeners.size, 1);
  for (const tick of state.intervals.values()) tick();
  await flush();
  assert.deepEqual(reads, [2, 2, 2]);
  state.visibility(false);
  subscriptions[0]!.refresh();
  assert.equal(state.intervals.size, 0);
  await flush();
  assert.deepEqual(reads, [2, 2, 2]);
  state.visibility(true);
  await flush();
  assert.deepEqual(reads, [3, 3, 3]);
  subscriptions.forEach((subscription) => subscription.stop());
  assert.deepEqual(poller.snapshot(), {
    subscribers: 0,
    pending: 0,
    timer: false,
  });
  assert.equal(state.listeners.size, 0);
  assert.equal(state.timeouts.size, 0);
});
test('pending reads coalesce, hide/unmount cancel, and an ignored abort cannot block recovery', async () => {
  const state = environment(),
    poller = new PublicPoller(state.env);
  const signals: AbortSignal[] = [];
  const subscription = poller.subscribe(async (signal) => {
    signals.push(signal);
    if (signals.length === 1) await new Promise(() => {});
  });
  await flush();
  subscription.refresh();
  subscription.refresh();
  assert.equal(signals.length, 1);
  state.visibility(false);
  state.visibility(true);
  await flush();
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals.length, 2);
  subscription.stop();
  assert.equal(signals[1]!.aborted, true);
  assert.equal(state.timeouts.size, 0);
  const stopped = poller.subscribe(async () => {
    throw new Error('must not start');
  });
  stopped.stop();
  await flush();
  assert.equal(state.listeners.size, 0);
});
test('deadline is reportable but visibility cancellation is quiet; stalled reads release their slot', async () => {
  const state = environment(),
    poller = new PublicPoller(state.env);
  let latest: AbortSignal | undefined;
  const subscription = poller.subscribe(async (signal) => {
    latest = signal;
    await new Promise(() => {});
  });
  await flush();
  for (const timeout of state.timeouts.values()) timeout();
  await flush();
  assert.equal(latest!.reason.name, 'TimeoutError');
  assert.equal(reportPublicFailure(latest!), true);
  assert.equal(poller.snapshot().pending, 0);
  subscription.refresh();
  await flush();
  state.visibility(false);
  await flush();
  assert.equal(reportPublicFailure(latest!), false);
  subscription.stop();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publicRead(Promise.resolve('late'), controller.signal),
    /abort/i,
  );
});
test('activity boundaries select the next exact start/end and retire finished events', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const competition = {
    startsAt: new Date(now + 1000).toISOString(),
    endsAt: new Date(now + 2000).toISOString(),
  } as WomCompetition;
  assert.equal(nextActivityBoundary([competition], now), now + 1000);
  assert.equal(nextActivityBoundary([competition], now + 1000), now + 2000);
  assert.equal(nextActivityBoundary([competition], now + 2000), undefined);
});

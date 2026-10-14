/** Reproducible local resource evidence. Synthetic data, no WOM/Discord credentials. */
import assert from 'node:assert/strict';
import { scrypt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { PasswordHasher } from '../apps/api/dist/passwords.js';
import {
  fetchWomCompetition,
  parseWomSnapshot,
  womResponseBytes,
} from '../apps/api/dist/wom.js';
import { skillIds } from '../apps/api/dist/xp-types.js';
import { BotWorkloads } from '../apps/bot/dist/workloads.js';
import { WorkloadError } from '../packages/domain/dist/index.js';
const phases = [
  'wom-before',
  'wom-after',
  'password-before',
  'password-after',
  'discord-before',
  'discord-after',
];
const phase = process.argv[2];
if (!phase) {
  for (const name of phases) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), name],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || 'Benchmark failed');
    process.stdout.write(result.stdout);
  }
} else {
  if (!phases.includes(phase)) throw new Error('Unknown measurement phase');
  const after = phase.endsWith('-after');
  const percentile = (values, fraction) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
    ] ?? 0;
  const startCpu = process.cpuUsage(),
    start = performance.now();
  const latency = [],
    waits = [],
    scenarios = [];
  let admitted = 0,
    rejected = 0,
    queries = 0;
  if (phase.startsWith('password')) {
    const submitted = new Map();
    const compute = (password, salt) => {
      waits.push(performance.now() - submitted.get(password));
      return new Promise((resolve, reject) =>
        scrypt(
          password,
          salt,
          64,
          { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
          (error, value) => (error ? reject(error) : resolve(value)),
        ),
      );
    };
    const hasher = new PasswordHasher(undefined, compute);
    await Promise.all(
      Array.from({ length: 24 }, async (_, n) => {
        const password = 'Synthetic benchmark ' + n,
          began = performance.now();
        submitted.set(password, began);
        try {
          if (after) await hasher.hash(password);
          else await compute(password, Buffer.alloc(16));
          admitted++;
          latency.push(performance.now() - began);
        } catch (error) {
          if (!(error instanceof WorkloadError)) throw error;
          rejected++;
        }
      }),
    );
    await hasher.close();
    scenarios.push({
      offered: 24,
      accepted: admitted,
      rejected,
      explicitQueueWaitP95Ms: percentile(waits, 0.95),
      nativeThreadPoolWaitMeasured: false,
      configuredActive: after ? 2 : 'native pool with unbounded admission',
      configuredQueued: after ? 4 : 'unbounded',
    });
  } else if (phase.startsWith('wom')) {
    const make = (players, metrics) => ({
      id: 123,
      title: 'Synthetic competition',
      startsAt: '2026-09-01T00:00:00.000Z',
      endsAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
      metrics: metrics.map((metric) => ({ metric, weight: 1 })),
      participantCount: players,
      participations: Array.from({ length: players }, (_, n) => ({
        playerId: n + 1,
        player: { displayName: 'Player ' + n },
        deltas: metrics.map((metric) => ({
          metric,
          values: { start: 0, end: 1, gained: '1' },
        })),
      })),
    });
    for (const [players, skills] of [
      [100, 1],
      [1000, 24],
      [10000, 1],
    ]) {
      const original = JSON.stringify(
        make(players, skills === 1 ? ['attack'] : ['overall']),
      );
      const breakdown =
        skills === 1 ? undefined : JSON.stringify(make(players, skillIds));
      const samples = [];
      for (let round = 0; round < 5; round++)
        await Promise.all(
          [0, 1].map(async () => {
            const began = performance.now();
            const snapshot = after
              ? await fetchWomCompetition(
                  'https://wiseoldman.net/competitions/123',
                  async (url) => {
                    const text = String(url).includes('?')
                      ? breakdown
                      : original;
                    const buffer = Buffer.from(text);
                    let offset = 0;
                    return new Response(
                      new ReadableStream({
                        pull(controller) {
                          if (offset >= buffer.length) {
                            controller.close();
                            return;
                          }
                          controller.enqueue(
                            buffer.subarray(offset, (offset += 65536)),
                          );
                        },
                      }),
                    );
                  },
                )
              : parseWomSnapshot(
                  JSON.parse(original),
                  breakdown ? JSON.parse(breakdown) : undefined,
                  123,
                );
            assert.equal(snapshot.participants.length, players);
            admitted++;
            const elapsed = performance.now() - began;
            samples.push(elapsed);
            latency.push(elapsed);
          }),
        );
      scenarios.push({
        players,
        skills,
        responses: breakdown ? 2 : 1,
        largestResponseBytes: Math.max(
          Buffer.byteLength(original),
          breakdown ? Buffer.byteLength(breakdown) : 0,
        ),
        requestsConcurrent: 2,
        samples: samples.length,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
      });
    }
    const maximumShapeBytes = Buffer.byteLength(
      JSON.stringify(make(10000, skillIds)),
    );
    scenarios.push({
      players: 10000,
      skills: 24,
      responseBytes: maximumShapeBytes,
      byteCeiling: womResponseBytes,
      fits: maximumShapeBytes <= womResponseBytes,
    });
  } else {
    const workloads = new BotWorkloads();
    const catalog = Array.from({ length: 1717 }, (_, n) => ({
      id: n + 1,
      name: 'Catalog item ' + n,
    }));
    for (let n = 0; n < 1000; n++) {
      const search = n % 2 === 0,
        user = 'user-' + (Math.floor(n / 2) % 10),
        began = performance.now();
      let release;
      try {
        if (after)
          release = (search ? workloads.search : workloads.intake).acquire([
            'guild',
            'guild:' + user,
          ]);
        // Count calls reaching the backend; this is not a PostgreSQL query benchmark.
        queries++;
        if (search)
          catalog.filter((row) => row.name.includes(String(n))).slice(0, 25);
        admitted++;
        latency.push(performance.now() - began);
      } catch (error) {
        if (!(error instanceof WorkloadError)) throw error;
        rejected++;
      } finally {
        release?.();
      }
    }
    scenarios.push({
      offered: 1000,
      users: 10,
      guilds: 1,
      backendCalls: queries,
      intake: after ? workloads.intake.snapshot() : null,
      search: after ? workloads.search.snapshot() : null,
      databaseQueriesMeasured: false,
      gatewayLatencyMeasured: false,
    });
  }
  const cpu = process.cpuUsage(startCpu);
  console.log(
    JSON.stringify({
      phase,
      node: process.version,
      platform: process.platform,
      milliseconds: performance.now() - start,
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      successfulP50Ms: percentile(latency, 0.5),
      successfulP95Ms: percentile(latency, 0.95),
      admitted,
      rejected,
      scenarios,
    }),
  );
}

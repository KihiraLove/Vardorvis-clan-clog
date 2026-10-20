import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPlan, runGates } from './check-gates.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'clog-gates-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('clog-gates-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { output: directory, write: () => {} };
}
const command = (name, code = 0) => [
  process.execPath,
  '-e',
  `console.log(${JSON.stringify(name)});console.error('fixture stderr');process.exitCode=${code}`,
];

test('failed stages and missing commands retain logs while independent checks run and dependents block', async (t) => {
  const options = await fixture(t);
  const report = await runGates(
    [
      {
        name: 'first',
        command: command('✖ first failure', 3),
        group: 'validate',
      },
      { name: 'dependent', command: command('must not run'), needs: ['first'] },
      { name: 'missing', command: ['clog-test-command-that-does-not-exist'] },
      { name: 'last', command: command('last'), group: 'validate' },
    ],
    options,
  );
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.gates.map(({ status }) => status),
    ['failed', 'blocked', 'failed', 'passed'],
  );
  assert.equal(report.gates[0].code, 3);
  assert.deepEqual(report.gates[0].failureLines, ['✖ first failure']);
  assert.match(report.gates[1].reason, /first/);
  assert.match(report.gates[2].error, /ENOENT/);
  assert.match(
    await readFile(path.join(options.output, 'validate.log'), 'utf8'),
    /first[\s\S]*fixture stderr[\s\S]*last/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(options.output, 'gates.json'), 'utf8')),
    report,
  );
});

test('the real stage plan continues after unit/browser/smoke failures and withholds release acceptance', async (t) => {
  const options = await fixture(t);
  const failures = new Set([
    'format',
    'test-api',
    'browser',
    'review',
    'security',
  ]);
  const plan = checkPlan({
    CHECK_REVISION: 'a'.repeat(40),
    CHECK_APP_IMAGE: 'clog-local-app:fixture',
  });
  const report = await runGates(
    plan.map((gate) => ({
      ...gate,
      command: command(gate.name, failures.has(gate.name) ? 1 : 0),
    })),
    options,
  );
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.gates
      .filter(({ status }) => status === 'failed')
      .map(({ name }) => name)
      .sort(),
    [...failures].sort(),
  );
  assert.deepEqual(
    report.gates
      .filter(({ status }) => status === 'blocked')
      .map(({ name }) => name),
    ['recovery', 'release-results'],
  );
  for (const name of [
    'test-bot',
    'test-web',
    'test-database',
    'test-domain',
    'loading',
    'stack',
    'catalog-proxy',
    'installation',
  ])
    assert.equal(
      report.gates.find((gate) => gate.name === name).status,
      'passed',
      name,
    );
  const source = await readFile(
    new URL('./compose-smoke.sh', import.meta.url),
    'utf8',
  );
  const scenarios = [...source.matchAll(/^([a-z-]+)\)/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    plan
      .filter(({ command }) => command[1] === 'scripts/compose-smoke.sh')
      .map(({ name }) => name)
      .sort(),
    scenarios.sort(),
  );
});

test('build failures block only required consumers, not independent test builds or image checks', async (t) => {
  const options = await fixture(t);
  const plan = checkPlan({
    CHECK_REVISION: 'a'.repeat(40),
    CHECK_APP_IMAGE: 'clog-local-app:fixture',
  });
  const report = await runGates(
    plan.map((gate) => ({
      ...gate,
      command: command(gate.name, gate.name === 'build-api' ? 1 : 0),
    })),
    options,
  );
  assert.equal(
    report.gates.find(({ name }) => name === 'test-api').status,
    'blocked',
  );
  assert.equal(
    report.gates.find(({ name }) => name === 'projections').status,
    'blocked',
  );
  for (const name of [
    'test-database',
    'test-bot',
    'test-web',
    'test-domain',
    'browser',
    'loading',
    'app-image',
    'security',
    'stack',
    'recovery',
  ])
    assert.equal(
      report.gates.find((gate) => gate.name === name).status,
      'passed',
      name,
    );
});

test('a nominally successful Node command with skipped tests still fails without stopping later stages', async (t) => {
  const options = await fixture(t);
  const report = await runGates(
    [
      { name: 'skipped', command: command('ℹ skipped 1'), nodeTests: true },
      { name: 'later', command: command('later') },
    ],
    options,
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.gates[0].status, 'failed');
  assert.match(report.gates[0].reason, /skip/);
  assert.equal(report.gates[1].status, 'passed');
});

test('competition failure blocks only fixture-dependent lifecycle and recovery checks', async (t) => {
  const options = await fixture(t);
  const plan = checkPlan({
    CHECK_REVISION: 'a'.repeat(40),
    CHECK_APP_IMAGE: 'clog-local-app:fixture',
  });
  const selected = new Set([
    'competitions',
    'lifecycle',
    'recovery',
    'installation',
    'review',
    'branding-proxy',
    'catalog-proxy',
  ]);
  const report = await runGates(
    plan
      .filter((gate) => selected.has(gate.name))
      .map((gate) => ({
        ...gate,
        needs: gate.needs.filter((name) => selected.has(name)),
        command: command(gate.name, gate.name === 'competitions' ? 1 : 0),
      })),
    options,
  );
  assert.deepEqual(
    report.gates
      .filter((gate) => gate.status === 'blocked')
      .map((gate) => gate.name),
    ['lifecycle', 'recovery'],
  );
  assert.equal(
    report.gates.find((gate) => gate.name === 'installation').status,
    'passed',
  );
});

test('interruption stops the active command and records remaining checks as blocked', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();
  const report = await runGates(
    [
      {
        name: 'active',
        command: [
          process.execPath,
          '-e',
          "console.log('ready');setInterval(()=>{},1000)",
        ],
      },
      { name: 'later', command: command('must not run') },
    ],
    {
      ...options,
      signal: controller.signal,
      write: (chunk) => {
        if (String(chunk).includes('ready')) controller.abort();
      },
    },
  );
  assert.equal(report.status, 'interrupted');
  assert.deepEqual(
    report.gates.map(({ status }) => status),
    ['interrupted', 'blocked'],
  );
});

test('a clean run passes and malformed stage definitions reject before execution', async (t) => {
  const options = await fixture(t);
  assert.equal(
    (await runGates([{ name: 'clean', command: command('clean') }], options))
      .status,
    'passed',
  );
  for (const gates of [
    [{ name: '../unsafe', command: command('unsafe') }],
    [{ name: 'first', needs: ['missing'], command: command('unsafe') }],
    [
      { name: 'same', command: command('unsafe') },
      { name: 'same', command: command('unsafe') },
    ],
  ])
    await assert.rejects(runGates(gates, options), /Invalid or unordered/);
});

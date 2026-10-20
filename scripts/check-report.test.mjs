import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  browserFailures,
  consoleSummary,
  writeRunReport,
} from './check-report.mjs';

const browser = (
  tests = [
    {
      projectName: 'chromium',
      expectedStatus: 'passed',
      results: [{ status: 'passed' }],
    },
  ],
) => ({
  config: { rootDir: '/app/apps/web/tests-loading' },
  errors: [],
  suites: [
    {
      title: 'loading.spec.ts',
      specs: [
        {
          title: 'fixture case',
          file: 'loading.spec.ts',
          line: 7,
          ok: tests.every(
            (test) =>
              test.results.length === 1 && test.results[0].status === 'passed',
          ),
          tests,
        },
      ],
    },
  ],
});
async function fixture(t) {
  const output = await mkdtemp(path.join(tmpdir(), 'clog-report-test-'));
  t.after(async () => {
    assert.equal(path.dirname(output), path.resolve(tmpdir()));
    assert.ok(path.basename(output).startsWith('clog-report-test-'));
    await rm(output, { recursive: true, force: true });
  });
  await writeFile(
    path.join(output, 'gates.json'),
    JSON.stringify({
      format: 1,
      status: 'passed',
      gates: [{ name: 'browser', status: 'passed', log: 'browser.log' }],
    }),
  );
  for (const suite of ['browser', 'loading', 'security', 'stack'])
    await writeFile(
      path.join(output, suite + '-report.json'),
      JSON.stringify(browser()),
    );
  return {
    output,
    run: {
      project: 'fixture',
      revision: 'a'.repeat(40),
      status: 'passed',
      interrupted: false,
      cleanupErrors: [],
    },
  };
}

test('final summary locates every browser failure and retained cross-platform trace after copying', async (t) => {
  const { output, run } = await fixture(t);
  const report = browser([
    {
      projectName: 'chromium',
      expectedStatus: 'passed',
      results: [
        {
          status: 'failed',
          retry: 0,
          errors: [{ message: 'Expected retry button\nAssertion details' }],
          attachments: [
            {
              name: 'trace',
              path: '/app/apps/web/test-results/loading/fixture/trace.zip',
            },
            {
              name: 'screenshot',
              path: 'F:\\repo\\apps\\web\\test-results\\loading\\fixture\\test-failed-1.png',
            },
            {
              name: 'unsafe',
              path: '/app/apps/web/test-results/../../outside',
            },
          ],
        },
        { status: 'passed', retry: 1, attachments: [] },
      ],
    },
  ]);
  await writeFile(
    path.join(output, 'loading-report.json'),
    JSON.stringify(report),
  );
  await mkdir(path.join(output, 'browser/loading/fixture'), {
    recursive: true,
  });
  await writeFile(
    path.join(output, 'browser/loading/fixture/trace.zip'),
    'fixture',
  );
  const result = await writeRunReport(output, { ...run, status: 'failed' });
  assert.equal(result.status, 'failed');
  assert.equal(result.browserFailures.length, 1);
  const failure = result.browserFailures[0];
  assert.equal(failure.status, 'flaky-or-unexpected-pass');
  assert.equal(failure.file, 'apps/web/tests-loading/loading.spec.ts');
  assert.equal(failure.line, 7);
  assert.deepEqual(
    failure.attempts.map(({ status }) => status),
    ['failed', 'passed'],
  );
  assert.deepEqual(
    failure.attachments.map(({ path, available }) => [path, available]),
    [
      ['browser/loading/fixture/trace.zip', true],
      ['browser/loading/fixture/test-failed-1.png', false],
      [undefined, false],
    ],
  );
  const markdown = await readFile(path.join(output, 'summary.md'), 'utf8');
  assert.match(markdown, /loading.spec.ts:7/);
  assert.match(markdown, /Expected retry button/);
  assert.match(markdown, /\[trace\]\(<browser\/loading\/fixture\/trace.zip>\)/);
  assert.match(markdown, /screenshot: evidence not retained/);
  assert.match(consoleSummary(result, output), /Trace:.*trace.zip/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')),
    result,
  );
});

test('skipped, unrun and expected-failure browser cases cannot disappear from the summary', () => {
  const tests = [
    { expectedStatus: 'skipped', results: [{ status: 'skipped' }] },
    { expectedStatus: 'passed', results: [] },
    { expectedStatus: 'failed', results: [{ status: 'failed' }] },
  ];
  assert.equal(browserFailures(browser(tests), 'stack').length, 3);
  const report = browser();
  report.errors = [{ message: 'Runner crashed' }];
  assert.equal(
    browserFailures(report, 'browser')[0].title,
    'Browser runner error',
  );
});

test('clean evidence passes; cleanup, missing reports, bad stage evidence and interruption remain failures', async (t) => {
  const { output, run } = await fixture(t);
  assert.equal((await writeRunReport(output, run)).status, 'passed');
  for (const failure of [
    { cleanupErrors: ['owned container could not be removed'] },
    { evidenceErrors: ['copy failed'] },
    { interrupted: true },
    { error: 'setup failed' },
  ])
    assert.equal(
      (await writeRunReport(output, { ...run, ...failure })).status,
      'failed',
    );
  await writeFile(
    path.join(output, 'gates.json'),
    JSON.stringify({
      format: 1,
      status: 'running',
      gates: [
        { name: 'active', status: 'running', log: 'active.log' },
        { name: 'later', status: 'pending', log: 'later.log' },
      ],
    }),
  );
  const interrupted = await writeRunReport(output, {
    ...run,
    interrupted: true,
  });
  assert.deepEqual(
    interrupted.gates.map(({ status }) => status),
    ['interrupted', 'blocked'],
  );
  await writeFile(
    path.join(output, 'gates.json'),
    '{"format":1,"gates":"broken"}',
  );
  await rm(path.join(output, 'stack-report.json'));
  const result = await writeRunReport(output, run);
  assert.equal(result.status, 'failed');
  assert.equal(result.gates.length, 0);
  assert.ok(result.evidenceErrors.length);
  assert.deepEqual(result.missingReports, ['stack-report.json']);
});

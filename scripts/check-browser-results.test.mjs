import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptance } from './check-browser-results.mjs';
const report = () => ({
  errors: [],
  suites: [
    {
      suites: [
        {
          specs: [
            {
              title: 'required case',
              ok: true,
              tests: [
                {
                  projectName: 'webkit',
                  expectedStatus: 'passed',
                  results: [{ status: 'passed' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});
test('acceptance collects nested real results and required scenario/engine evidence', () => {
  assert.deepEqual(
    acceptance(report(), { projects: ['webkit'], titles: ['required case'] }),
    { tests: 1, projects: ['webkit'] },
  );
});
test('successful expected failures, skips and retried passes cannot count as acceptance', () => {
  for (const change of [
    (value) => {
      value.expectedStatus = 'failed';
      value.results[0].status = 'failed';
    },
    (value) => {
      value.expectedStatus = 'skipped';
      value.results[0].status = 'skipped';
    },
    (value) => {
      value.results.unshift({ status: 'failed' });
    },
    (value) => {
      value.results[0].status = 'timedOut';
    },
  ]) {
    const value = report();
    change(value.suites[0].suites[0].specs[0].tests[0]);
    assert.throws(() => acceptance(value), /must pass normally once/u);
  }
});
test('missing required cases or browser projects fail even if remaining cases pass', () => {
  assert.throws(
    () => acceptance(report(), { projects: ['chromium', 'firefox', 'webkit'] }),
    /Missing browser engine/u,
  );
  assert.throws(
    () => acceptance(report(), { titles: ['removed audit regression'] }),
    /Missing required audit case/u,
  );
  const partial = report();
  partial.suites[0].suites[0].specs.push({
    title: 'different case',
    ok: true,
    tests: [
      {
        projectName: 'firefox',
        expectedStatus: 'passed',
        results: [{ status: 'passed' }],
      },
    ],
  });
  assert.throws(
    () =>
      acceptance(partial, {
        projects: ['webkit', 'firefox'],
        titles: ['required case'],
      }),
    /Missing required audit case.*firefox/u,
  );
});
test('empty, malformed and globally errored reports fail closed', () => {
  for (const value of [
    {},
    { suites: [] },
    { ...report(), errors: [{ message: 'global setup failed' }] },
  ])
    assert.throws(() => acceptance(value));
});

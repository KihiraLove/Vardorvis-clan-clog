import assert from 'node:assert/strict';
import test from 'node:test';
import { lockHash } from './check-dependencies.mjs';
import { auditTitles, stackTitles } from './check-browser-results.mjs';
import {
  evidenceFiles,
  requiredRegressions,
  requiredRecovery,
  releaseSummary,
} from './check-release-results.mjs';
const revision = 'a'.repeat(40),
  lock = 'a specific lockfile',
  now = Date.parse('2026-10-15T12:00:00Z');
function browser(titles, projects = ['']) {
  return {
    errors: [],
    suites: [
      {
        specs: titles.map((title) => ({
          title,
          ok: true,
          tests: projects.map((projectName) => ({
            projectName,
            expectedStatus: 'passed',
            results: [{ status: 'passed' }],
          })),
        })),
      },
    ],
  };
}
function fixture() {
  const node = 'ℹ tests 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n';
  return {
    ...Object.fromEntries(
      evidenceFiles.map((name) => [name, 'completed gate\n']),
    ),
    'validate.log':
      node.repeat(5) +
      requiredRegressions.map((title) => '✔ ' + title + ' (1ms)').join('\n'),
    'tools.log': node,
    'dependencies.json': JSON.stringify({
      format: 1,
      status: 'passed',
      checkedAt: new Date(now).toISOString(),
      lockfileSha256: lockHash(lock),
      counts: { total: 0, high: 0, critical: 0 },
    }),
    'browser-report.json': JSON.stringify(browser(auditTitles)),
    'loading-report.json': JSON.stringify(browser(['cold loading'])),
    'security-report.json': JSON.stringify(browser(['enforced CSP'])),
    'stack-report.json': JSON.stringify(
      browser(stackTitles, ['chromium', 'firefox', 'webkit']),
    ),
    'runtime-image.json': JSON.stringify({ status: 'passed' }),
    'web-bundle.json': JSON.stringify({
      publicBytes: 302000,
      publicGzipBytes: 94000,
    }),
    'recovery/result.json': JSON.stringify({
      status: 'passed',
      cleanup: 'passed',
      scenarios: requiredRecovery,
    }),
  };
}
function change(files, name, mutate) {
  const value = JSON.parse(files[name]);
  mutate(value);
  files[name] = JSON.stringify(value);
}
const summary = (files) => releaseSummary(files, revision, lock, now);
test('complete automated evidence stays distinct from manual launch acceptance and records hashes', () => {
  const files = fixture(),
    result = summary(files);
  assert.equal(result.automatedStatus, 'passed');
  assert.equal(result.launchStatus, 'manual-checks-pending');
  assert.equal(result.tests.total, 27);
  assert.equal(result.recoveryScenarios, 11);
  assert.ok(result.manualChecks.every((value) => value.status === 'pending'));
  assert.equal(Object.keys(result.evidenceSha256).length, evidenceFiles.length);
  assert.notEqual(
    result.evidenceSha256['validate.log'],
    lockHash(files['validate.log'] + 'changed'),
  );
});
test('missing, skipped, TODO or omitted original database/retry regressions cannot produce acceptance', () => {
  for (const kind of ['fail', 'cancelled', 'skipped', 'todo']) {
    const files = fixture();
    files['validate.log'] = files['validate.log'].replace(
      'ℹ ' + kind + ' 0',
      'ℹ ' + kind + ' 1',
    );
    assert.throws(() => summary(files), /Node acceptance/u);
  }
  for (const title of requiredRegressions) {
    const files = fixture();
    files['validate.log'] = files['validate.log'].replace(
      '✔ ' + title,
      'omitted',
    );
    assert.throws(() => summary(files), /Required normal regression/u);
  }
  const files = fixture();
  files['validate.log'] = '';
  assert.throws(() => summary(files), /Missing required Node/u);
});
test('stale, future, mismatched or nonpassing dependency evidence and invalid revisions are rejected', () => {
  for (const mutate of [
    (value) => {
      value.checkedAt = new Date(now - 86400001).toISOString();
    },
    (value) => {
      value.checkedAt = new Date(now + 300001).toISOString();
    },
    (value) => {
      value.lockfileSha256 = 'b'.repeat(64);
    },
    (value) => {
      value.status = 'failed';
    },
    (value) => {
      value.counts.critical = 1;
    },
    (value) => {
      value.checkedAt = 'not a date';
    },
  ]) {
    const files = fixture();
    change(files, 'dependencies.json', mutate);
    assert.throws(() => summary(files), /Dependency evidence/u);
  }
  assert.throws(
    () => releaseSummary(fixture(), 'main', lock, now),
    /Exact revision/u,
  );
});
test('missing reports, hidden browser failures and incomplete engine coverage fail the release guard', () => {
  const missing = fixture();
  delete missing['smoke.log'];
  assert.throws(() => summary(missing), /Missing evidence/u);
  const bad = fixture();
  change(bad, 'security-report.json', (value) => {
    value.suites[0].specs[0].tests[0].results[0].status = 'failed';
  });
  assert.throws(() => summary(bad), /must pass normally/u);
  const partial = fixture();
  change(partial, 'stack-report.json', (value) => {
    value.suites[0].specs[0].tests.pop();
  });
  assert.throws(() => summary(partial), /Missing required audit case/u);
});
test('runtime inspection, every recovery scenario, cleanup and bundle budgets are required', () => {
  for (const [name, mutate] of [
    [
      'runtime-image.json',
      (value) => {
        value.status = 'failed';
      },
    ],
    [
      'recovery/result.json',
      (value) => {
        value.cleanup = 'failed';
      },
    ],
    [
      'recovery/result.json',
      (value) => {
        value.scenarios[0] = 'a different recovery';
      },
    ],
    [
      'web-bundle.json',
      (value) => {
        value.publicBytes = 320001;
      },
    ],
  ]) {
    const files = fixture();
    change(files, name, mutate);
    assert.throws(() => summary(files));
  }
});

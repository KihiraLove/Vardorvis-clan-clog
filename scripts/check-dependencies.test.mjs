import assert from 'node:assert/strict';
import test from 'node:test';
import { advisorySummary } from './check-dependencies.mjs';
const report = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
});
test('advisory policy records lower severity findings and blocks high or critical packages', () => {
  assert.equal(advisorySummary(report(), 0).status, 'passed');
  for (const severity of ['low', 'moderate', 'high', 'critical']) {
    const value = report();
    value.vulnerabilities.example = { severity, isDirect: true };
    value.metadata.vulnerabilities[severity] = 1;
    value.metadata.vulnerabilities.total = 1;
    const result = advisorySummary(
      value,
      ['high', 'critical'].includes(severity) ? 1 : 0,
    );
    assert.equal(
      result.status,
      ['high', 'critical'].includes(severity) ? 'failed' : 'passed',
    );
    assert.deepEqual(result.packages, [
      { name: 'example', severity, direct: true },
    ]);
  }
});
test('registry failures, missing data and inconsistent or unknown advisory results fail closed', () => {
  for (const [value, exit] of [
    [{}, 0],
    [report(), null],
    [report(), 2],
    [report(), 1],
    [{ ...report(), error: { code: 'unavailable' } }, 1],
    [{ ...report(), auditReportVersion: 1 }, 0],
  ])
    assert.throws(() => advisorySummary(value, exit));
  for (const mutate of [
    (v) => {
      v.metadata.vulnerabilities.high = -1;
    },
    (v) => {
      v.metadata.vulnerabilities.total = 1;
    },
    (v) => {
      v.vulnerabilities.example = { severity: 'unknown' };
      v.metadata.vulnerabilities.total = 1;
      v.metadata.vulnerabilities.low = 1;
    },
    (v) => {
      v.vulnerabilities.example = { severity: 'high' };
      v.metadata.vulnerabilities.total = 1;
      v.metadata.vulnerabilities.low = 1;
    },
  ]) {
    const value = report();
    mutate(value);
    assert.throws(() => advisorySummary(value, 0));
  }
});

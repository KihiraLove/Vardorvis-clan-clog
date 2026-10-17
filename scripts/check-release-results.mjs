/** Consolidate required automated evidence; a local pass is never live launch approval. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  acceptance,
  auditTitles,
  stackTitles,
} from './check-browser-results.mjs';
import { lockHash } from './check-dependencies.mjs';

export const requiredRegressions = [
  'concurrent migrators serialize a fresh schema without duplicate ledger entries',
  'a changed migration checksum rejects startup without changing the ledger',
  'a failed fresh migration rolls back both partial schema and its ledger',
  'an image rejects unknown future ledger entries before mutating the schema',
  'a missing baseline ledger entry cannot reinitialize a populated database',
  'fresh setup seeds generic defaults without historical audits or retired authentication',
  'runtime role reconciles the complete permission matrix and rotates credentials without broadening access',
  'transport timeout followed by a durable 200 replay confirms exactly one pending receipt',
  'transport/5xx uncertainty followed by 401, 403 or 422 cannot claim nothing was saved',
];
export const manualChecks = [
  'isolated-discord-guild: autocomplete, private receipt, durable replay/uncertainty, in-flight shutdown',
  'deployed-host: DNS/TLS, pinned image/revision/schema, readiness and owner-only safe diagnostics',
  'supported-devices: desktop/mobile, keyboard/touch/accessibility and physical Safari review',
  'host-recovery: off-host restore, capacity and actual published prior-release rehearsal',
  'release-review: dependency findings, retained limits and normal production-environment approval',
];
export const requiredRecovery = [
  'real coordinated backup with actual image/schema/infrastructure evidence',
  'fresh namespace: all database tables/files exact',
  'corrupt/incomplete backup and existing namespace rejected',
  'canonical atomic release record controls backup',
  'unavailable image leaves current writer untouched',
  'changed infrastructure bytes rejected',
  'older image missing applied migration rejected',
  'partial DDL migration failure rolls back',
  'controlled compatible image promotion and approved previous-image rollback',
  'runtime credential rotation rejects new connections',
  'critical API process crash fails container',
];
export const evidenceFiles = [
  'workflows.log',
  'supervisor.log',
  'tools.log',
  'dependencies.log',
  'validate.log',
  'workloads.log',
  'projections.log',
  'browser.log',
  'loading.log',
  'smoke.log',
  'browser-results.log',
  'dependencies.json',
  'browser-report.json',
  'loading-report.json',
  'security-report.json',
  'stack-report.json',
  'runtime-image.json',
  'web-bundle.json',
  'recovery/result.json',
];

function nodeResults(log, groups) {
  const counts = [...log.matchAll(/ℹ tests (\d+)/gu)].map((match) =>
    Number(match[1]),
  );
  if (counts.length !== groups || counts.some((count) => count < 1))
    throw new Error('Missing required Node test results');
  for (const kind of ['fail', 'cancelled', 'skipped', 'todo']) {
    const values = [...log.matchAll(new RegExp(`ℹ ${kind} (\\d+)`, 'gu'))];
    if (
      values.length !== groups ||
      values.some((match) => Number(match[1]) !== 0)
    )
      throw new Error(
        `Node acceptance contains missing/nonzero ${kind} results`,
      );
  }
  return counts.reduce((sum, count) => sum + count, 0);
}

export function releaseSummary(files, revision, lockfile, now = Date.now()) {
  if (!/^[a-f0-9]{40}$/u.test(revision ?? ''))
    throw new Error('Exact revision required');
  for (const name of evidenceFiles)
    if (typeof files[name] !== 'string')
      throw new Error(`Missing evidence: ${name}`);
  const json = (name) => JSON.parse(files[name]);
  const workspaceTests = nodeResults(files['validate.log'], 5);
  const toolingTests = nodeResults(files['tools.log'], 1);
  const lines = files['validate.log']
    .split(/\r?\n/u)
    .map((line) => line.trimStart());
  for (const title of requiredRegressions)
    if (!lines.some((line) => line.startsWith('✔ ' + title + ' (')))
      throw new Error('Required normal regression missing: ' + title);
  const dependencies = json('dependencies.json');
  const age = now - Date.parse(dependencies.checkedAt);
  if (
    dependencies.format !== 1 ||
    dependencies.status !== 'passed' ||
    dependencies.lockfileSha256 !== lockHash(lockfile) ||
    !Number.isFinite(age) ||
    age < -300000 ||
    age > 86400000 ||
    dependencies.counts?.high !== 0 ||
    dependencies.counts?.critical !== 0
  )
    throw new Error(
      'Dependency evidence must be fresh, passing and match this lockfile',
    );
  const browsers = {};
  for (const name of ['browser', 'loading', 'security', 'stack'])
    browsers[name] = acceptance(
      json(name + '-report.json'),
      name === 'browser'
        ? { titles: auditTitles }
        : name === 'stack'
          ? { projects: ['chromium', 'firefox', 'webkit'], titles: stackTitles }
          : {},
    );
  const runtime = json('runtime-image.json'),
    recovery = json('recovery/result.json'),
    bundle = json('web-bundle.json');
  if (
    runtime.status !== 'passed' ||
    recovery.status !== 'passed' ||
    recovery.cleanup !== 'passed' ||
    !Array.isArray(recovery.scenarios) ||
    recovery.scenarios.length < 11 ||
    new Set(recovery.scenarios).size !== recovery.scenarios.length
  )
    throw new Error(
      'Production-image and complete isolated recovery evidence required',
    );
  for (const scenario of requiredRecovery)
    if (
      !recovery.scenarios.some(
        (value) => typeof value === 'string' && value.startsWith(scenario),
      )
    )
      throw new Error('Missing recovery scenario: ' + scenario);
  if (!(
    bundle.publicBytes > 0 &&
    bundle.publicBytes <= 320000 &&
    bundle.publicGzipBytes > 0 &&
    bundle.publicGzipBytes <= 100000
  ))
    throw new Error('Public bundle exceeds acceptance budget');
  return {
    format: 1,
    revision,
    generatedAt: new Date(now).toISOString(),
    automatedStatus: 'passed',
    launchStatus: 'manual-checks-pending',
    scope:
      'Working tree copied by the runner; release review must use a clean exact commit and outer result.json with successful cleanup.',
    tests: {
      workspace: workspaceTests,
      tooling: toolingTests,
      browsers,
      total:
        workspaceTests +
        toolingTests +
        Object.values(browsers).reduce((sum, item) => sum + item.tests, 0),
    },
    requiredRegressions: requiredRegressions.length,
    recoveryScenarios: recovery.scenarios.length,
    dependencyCounts: dependencies.counts,
    evidenceSha256: Object.fromEntries(
      evidenceFiles.map((name) => [name, lockHash(files[name])]),
    ),
    manualChecks: manualChecks.map((check) => ({ check, status: 'pending' })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = '.data/local-checks';
  const files = Object.fromEntries(
    await Promise.all(
      evidenceFiles.map(async (name) => [
        name,
        await readFile(path.join(root, name), 'utf8'),
      ]),
    ),
  );
  const summary = releaseSummary(
    files,
    process.env.CHECK_REVISION,
    await readFile('package-lock.json'),
  );
  await writeFile(
    path.join(root, 'acceptance.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  console.log(JSON.stringify(summary, null, 2));
}

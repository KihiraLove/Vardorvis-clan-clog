/** Fresh advisory evidence for the exact lockfile; never installs or fixes packages. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const lockHash = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export function advisorySummary(report, exitCode) {
  const counts = report?.metadata?.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (
    report?.auditReportVersion !== 2 ||
    report.error ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities) ||
    !counts ||
    ![0, 1].includes(exitCode) ||
    [...severities, 'total'].some(
      (key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0,
    ) ||
    severities.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
    Object.keys(report.vulnerabilities).length !== counts.total
  )
    throw new Error('Unavailable or invalid npm advisory report');
  if (counts.high + counts.critical > 0 !== (exitCode === 1))
    throw new Error('npm exit status does not match advisory policy');
  const packages = Object.entries(report.vulnerabilities).map(
    ([name, value]) => {
      if (!severities.includes(value.severity))
        throw new Error('Invalid npm advisory severity');
      return {
        name,
        severity: value.severity,
        direct: value.isDirect === true,
      };
    },
  );
  for (const severity of severities)
    if (
      packages.filter((entry) => entry.severity === severity).length !==
      counts[severity]
    )
      throw new Error('Inconsistent npm advisory counts');
  return {
    status: counts.high + counts.critical === 0 ? 'passed' : 'failed',
    policy: 'block-high-and-critical; review-all-lower-severity-findings',
    counts,
    packages,
  };
}

export async function main() {
  const output = '.data/local-checks/dependencies.json';
  await mkdir(path.dirname(output), { recursive: true });
  const checkedAt = new Date().toISOString();
  let evidence;
  try {
    const lock = await readFile('package-lock.json');
    const audit = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'audit',
        '--json',
        '--audit-level=high',
        '--registry=https://registry.npmjs.org/',
      ],
      {
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (audit.error || audit.signal)
      throw new Error('npm advisory request failed');
    evidence = {
      format: 1,
      checkedAt,
      lockfileSha256: lockHash(lock),
      source: 'https://registry.npmjs.org/',
      scope: 'complete lockfile, including development dependencies',
      ...advisorySummary(JSON.parse(audit.stdout), audit.status),
    };
  } catch {
    // Do not print registry/network errors, local npm config or raw audit payloads.
    evidence = {
      format: 1,
      checkedAt,
      status: 'failed',
      reason: 'Advisory service/report unavailable; retry the gate.',
    };
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

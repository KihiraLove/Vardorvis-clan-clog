/** Consolidate retained stage logs and Playwright failures after Docker cleanup. */
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function browserFailures(report, suite) {
  if (!Array.isArray(report?.suites)) throw Error('Invalid browser report');
  const failures = (report.errors ?? []).map((error) => ({
    suite,
    title: 'Browser runner error',
    status: 'failed',
    errors: [error.message ?? String(error)],
    attachments: [],
  }));
  const visit = (suites, parents = []) => {
    for (const group of suites) {
      for (const spec of group.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const results = test.results ?? [];
          if (
            spec.ok &&
            test.expectedStatus === 'passed' &&
            results.length === 1 &&
            results[0].status === 'passed'
          )
            continue;
          const last = results.at(-1);
          let source = (spec.file ?? group.file)?.replaceAll('\\', '/');
          const root = report.config?.rootDir?.replaceAll('\\', '/');
          if (source?.includes('apps/web/'))
            source = source.slice(source.indexOf('apps/web/'));
          else if (
            source &&
            root?.includes('apps/web/') &&
            !path.posix.isAbsolute(source)
          )
            source = root.slice(root.indexOf('apps/web/')) + '/' + source;
          failures.push({
            suite,
            title: [...parents, group.title, spec.title]
              .filter(Boolean)
              .join(' › '),
            file: source,
            line: spec.line,
            project: test.projectName,
            status:
              last?.status === 'passed'
                ? 'flaky-or-unexpected-pass'
                : (last?.status ?? 'not-run'),
            errors: results
              .flatMap(
                (result) =>
                  result.errors ?? (result.error ? [result.error] : []),
              )
              .map((error) => error.message ?? String(error)),
            attempts: results.map(({ status, retry }) => ({ status, retry })),
            attachments: results
              .flatMap((result) => result.attachments ?? [])
              .filter(({ path }) => path)
              .map((attachment) => {
                const normalized = attachment.path.replaceAll('\\', '/');
                const marker = '/test-results/';
                const offset = normalized.lastIndexOf(marker);
                const relative =
                  offset >= 0
                    ? normalized.slice(offset + marker.length)
                    : normalized.startsWith('test-results/')
                      ? normalized.slice(13)
                      : undefined;
                const safe =
                  relative &&
                  !relative
                    .split('/')
                    .some((part) => part === '..' || part === '.');
                return {
                  name: attachment.name,
                  ...(safe ? { path: 'browser/' + relative } : {}),
                };
              }),
          });
        }
      }
      visit(group.suites ?? [], [...parents, group.title].filter(Boolean));
    }
  };
  visit(report.suites);
  return failures;
}

export async function writeRunReport(output, run) {
  const evidenceErrors = [...(run.evidenceErrors ?? [])];
  let stages;
  try {
    stages = JSON.parse(
      await readFile(path.join(output, 'gates.json'), 'utf8'),
    );
    if (stages.format !== 1 || !Array.isArray(stages.gates))
      throw Error('Invalid stage report');
  } catch {
    stages = undefined;
    evidenceErrors.push(
      'Stage report unavailable; setup may have failed before checks started.',
    );
  }
  const failures = [],
    missingReports = [];
  for (const suite of ['browser', 'loading', 'security', 'stack']) {
    try {
      const report = JSON.parse(
        await readFile(path.join(output, suite + '-report.json'), 'utf8'),
      );
      failures.push(...browserFailures(report, suite));
    } catch {
      missingReports.push(suite + '-report.json');
    }
  }
  for (const failure of failures)
    for (const attachment of failure.attachments)
      attachment.available =
        !!attachment.path &&
        (await access(path.join(output, attachment.path)).then(
          () => true,
          () => false,
        ));
  const gates = (stages?.gates ?? []).map((gate) =>
    ['pending', 'running'].includes(gate.status)
      ? {
          ...gate,
          status:
            run.interrupted && gate.status === 'running'
              ? 'interrupted'
              : 'blocked',
          reason: run.interrupted
            ? 'Run interrupted'
            : 'Runner ended before this stage completed',
        }
      : gate,
  );
  const status =
    run.status === 'passed' &&
    !run.interrupted &&
    !run.error &&
    !run.cleanupErrors?.length &&
    stages?.status === 'passed' &&
    gates.length &&
    gates.every((gate) => gate.status === 'passed') &&
    !failures.length &&
    !missingReports.length &&
    !evidenceErrors.length
      ? 'passed'
      : 'failed';
  const result = {
    ...run,
    status,
    gates,
    browserFailures: failures,
    missingReports,
    evidenceErrors,
  };
  const lines = [
    '# Local checks: ' +
      (run.interrupted ? 'INTERRUPTED' : status.toUpperCase()),
    '',
    `Revision: \`${run.revision}\``,
    '',
    ...(run.error ? ['Runner: ' + run.error, ''] : []),
    '| Stage | Result | Log |',
    '| --- | --- | --- |',
    ...gates.map(
      (gate) =>
        `| ${gate.name} | ${gate.status.toUpperCase()} | [log](<${gate.log}>) |`,
    ),
    '',
  ];
  for (const gate of gates.filter(({ status }) => status !== 'passed')) {
    lines.push(
      `## ${gate.name}: ${gate.status.toUpperCase()}`,
      '',
      gate.reason ?? gate.error ?? `Exit code: ${gate.code ?? 'unavailable'}`,
      '',
    );
    for (const line of gate.failureLines ?? []) lines.push('    ' + line);
    lines.push('', `[Full stage log](<${gate.log}>)`, '');
  }
  for (const failure of failures) {
    lines.push(
      `## ${failure.suite}: ${failure.title}`,
      '',
      `Result: ${failure.status}${failure.project ? ' (' + failure.project + ')' : ''}`,
      '',
    );
    if (failure.file)
      lines.push(`Source: \`${failure.file}:${failure.line ?? 1}\``, '');
    for (const error of failure.errors)
      lines.push('    ' + error.replaceAll('\n', '\n    '), '');
    for (const attachment of failure.attachments)
      lines.push(
        attachment.available
          ? `- [${attachment.name}](<${attachment.path}>)`
          : `- ${attachment.name}: evidence not retained`,
        '',
      );
  }
  for (const message of [
    ...evidenceErrors,
    ...missingReports.map((file) => 'Missing browser report: ' + file),
    ...(run.cleanupErrors ?? []).map((message) => 'Cleanup failed: ' + message),
  ])
    lines.push(message, '');
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  await writeFile(path.join(output, 'summary.md'), lines.join('\n') + '\n');
  return result;
}

export function consoleSummary(result, output) {
  const failed = result.gates.filter(({ status }) => status !== 'passed');
  const lines = [
    `\nLocal checks ${result.interrupted ? 'interrupted' : result.status}. ${failed.length} failed/blocked stages; ${result.browserFailures.length} browser cases need attention.`,
    `Summary: ${path.join(output, 'summary.md')}`,
  ];
  if (result.error) lines.push('Runner: ' + result.error);
  for (const message of [
    ...result.evidenceErrors,
    ...result.missingReports.map((name) => 'Missing browser report: ' + name),
  ])
    lines.push(message);
  for (const gate of failed)
    lines.push(
      `${gate.status.toUpperCase()} ${gate.name}: ${path.join(output, gate.log)}`,
    );
  for (const failure of result.browserFailures) {
    lines.push(
      `${failure.suite}: ${failure.title}${failure.file ? ' — ' + failure.file + ':' + (failure.line ?? 1) : ''}`,
    );
    for (const attachment of failure.attachments.filter(
      ({ name }) => name === 'trace',
    ))
      lines.push(
        attachment.available
          ? '  Trace: ' + path.join(output, attachment.path)
          : '  Trace not retained; see the stage log.',
      );
  }
  return lines.join('\n');
}

/** A green Playwright exit must never conceal skips, expected failures or retries. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function acceptance(report, { projects = [], titles = [] } = {}) {
  if (!Array.isArray(report.suites) || report.errors?.length)
    throw new Error('Invalid or errored browser report');
  const cases = [];
  const visit = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (
            !spec.ok ||
            test.expectedStatus !== 'passed' ||
            test.results?.length !== 1 ||
            test.results[0].status !== 'passed'
          )
            throw new Error(
              `Browser case must pass normally once: ${spec.title}`,
            );
          cases.push({ title: spec.title, project: test.projectName });
        }
      }
      visit(suite.suites ?? []);
    }
  };
  visit(report.suites);
  if (!cases.length) throw new Error('Empty browser report');
  for (const project of projects)
    if (!cases.some((value) => value.project === project))
      throw new Error(`Missing browser engine: ${project}`);
  for (const title of titles)
    for (const project of projects.length ? projects : [undefined])
      if (
        !cases.some(
          (value) =>
            value.title === title &&
            (project === undefined || value.project === project),
        )
      )
        throw new Error(
          `Missing required audit case: ${title}${project ? ` (${project})` : ''}`,
        );
  return {
    tests: cases.length,
    projects: [...new Set(cases.map((value) => value.project))],
  };
}

export const auditTitles = [
  'audit: live queue follows next and previous cursors and respects boundaries',
  'audit: saved hardcore=false allows proof acknowledgement and approval',
  'audit: saved hardcore=true allows proof acknowledgement and approval',
  'audit: rejection needs a reason but does not need proof acknowledgement',
  'audit: reviewed approved credit can be revoked with a reason',
  'audit: logged-out sessions have no admin navigation',
  'audit: a pagination boundary does not use a loading cursor',
  'audit: an ordinary-world review note can be saved, discarded, cleared and reloaded independently',
  'audit: retain the current admin page until destination data is ready',
  'audit: the retired XP imports URL opens the shared scheduling competition form',
];

export const stackTitles = [
  'real login, PNG claim, independent note/correction, canonical public credit and audited revoke',
  'real moderator setup, role denial and server-side access revocation clear private drafts',
  'slow real reads preserve keyboard navigation; catalog geometry and both proxy logo uploads work',
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = {};
  for (const name of ['browser', 'loading', 'security', 'stack']) {
    const report = JSON.parse(
      await readFile(`.data/local-checks/${name}-report.json`, 'utf8'),
    );
    results[name] = acceptance(
      report,
      name === 'browser'
        ? { titles: auditTitles }
        : name === 'stack'
          ? { projects: ['chromium', 'firefox', 'webkit'], titles: stackTitles }
          : {},
    );
  }
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
}

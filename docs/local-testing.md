# Development and tests

Use Node 24. For host development:

```bash
npm ci
npm run build
npm run dev:web
# In another terminal, with configured local DB/storage:
npm run dev:api
```

Vite proxies `/api` to `127.0.0.1:3000`. The frontend always uses the API;
there is no demo fallback. Browser fixtures live under `apps/web/tests/support`
and cannot enter production bundles. See [configuration](environment.md).

## Focused checks

Run checks for the behavior/files you changed. Examples:

```bash
npx prettier --check path/to/changed-file.ts
npx eslint apps/web/src/changed-file.ts
npm run typecheck -w @clog/web
node --test apps/web/src/changed-file.test.ts
npm run build -w @clog/database
node --test packages/database/dist/migration-audit.test.js
npm run check:docs
```

Database tests need `TEST_DATABASE_URL` pointing to a disposable PostgreSQL 17
database. They can create/drop schemas and change roles; never use personal or
production data. Some tests skip without it, which is not complete validation.
Build shared packages before running their dependent compiled tests.

For the container startup changes, build a disposable image and run only its
installation checks:

```bash
docker build --target app -t clan-clog:checks .
CHECK_APP_IMAGE=clan-clog:checks node scripts/installation-smoke.mjs
```

This creates and removes its own Compose project and volumes. It covers interrupted
first setup, password changes, persistence, credentials, maintenance and multiple
installations alongside an unrelated service.

For UI behavior, run a selected Playwright spec from `apps/web`, for example
`npx playwright test tests/admin.spec.ts --grep 'review'`. Its config starts
Vite on port 5187. Use a production web build to verify bundle budgets and that
no staff/test modules enter the initial public bundle.

## Complete acceptance

The maintainer runs this before release, with Linux Docker running:

```bash
node scripts/check-local.mjs
```

Only Node 24 and Docker Compose 2.24.4+ are required on the host. The runner
builds isolated Linux tooling, PostgreSQL and browser environments without
reading runtime `.env` or logging into real Discord. It covers formatting,
lint, builds, catalog checks, typechecks, Node tests, three-browser HTTPS flows,
security headers, image inspection, performance and backup/recovery. Full
acceptance rejects skips and missing required scenarios.

Reports and logs are in `.data/local-checks/<run-id>/`; record the tested commit
and dirty/clean state. The runner removes its own containers and volumes.
After a crash, inspect resources labelled `clog.local-checks` and clean up only
that run's namespace. Avoid global Docker prune on a shared machine.

Hosted CI runs manually or on a published Release. Publishing waits for complete
acceptance. Local evidence does not replace checking your own HTTPS host,
Discord guild, supported devices and off-host recovery before launch.

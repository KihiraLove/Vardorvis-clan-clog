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

After pulling a catalog update, stop the API watcher and refresh the local database
with its owner credentials. For an owner-configured local `.env`:

```bash
node --env-file=.env packages/database/dist/migrate.js
node --env-file=.env packages/database/dist/catalog-import.js
npm run dev:api
```

Compile changed domain/database/API sources first. Use the owner connection for
these two maintenance commands; the restricted runtime role cannot install release
batches. Starting Vite or the direct API watcher alone does not run catalog import.
Production startup performs this refresh automatically. Existing installations
offer the first administrator an update review; fresh installs include the content
without an upgrade prompt. Running tests does not refresh a development database.

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
and dirty/clean state. Independent checks continue after failures. Checks that
need a failed build, unavailable test service or missing prerequisite fixture data
are marked **blocked**, and the
run still exits with an error. Initial tooling/database setup must succeed before
the test runner can start.

At the end, open `summary.md` for stage results, failed browser test locations and
links to retained screenshots and traces. `result.json` contains the same result
as structured data; `gates.json` tracks stage progress, and each stage has its own
log. To inspect a trace, run `npx playwright show-trace <path-to-trace.zip>` from
`apps/web`. Missing reports or failed evidence copying also fail the run.

The runner removes its own containers and volumes.
After a crash, inspect resources labelled `clog.local-checks` and clean up only
that run's namespace. Avoid global Docker prune on a shared machine.

Hosted CI runs manually or on a published Release. Publishing waits for complete
acceptance. Local evidence does not replace checking your own HTTPS host,
Discord guild, supported devices and off-host recovery before launch.

## Focused catalog upgrade smoke

`scripts/catalog-update-smoke.mjs` is an opt-in check for a freshly started,
disposable production container. It requires no submissions or installed content
updates and uses only temporary credentials/data. Never run it on a hosted clan's
installation. Copy it into the test container, then run:

```bash
docker cp scripts/catalog-update-smoke.mjs <disposable-container>:/tmp/catalog-update-smoke.mjs
docker exec -e CATALOG_UPDATE_SMOKE_TEST=1 <disposable-container> node /tmp/catalog-update-smoke.mjs
```

The container needs its normal HTTPS `PUBLIC_ORIGIN`. The check uses real
login/password change, CSRF/Origin validation, runtime-role catalog corrections,
idempotent replay, retained local identity/credit, and a temporary PostgreSQL
dump/restore of images, prompt state and receipts. It removes the restored
database/dump; remove the disposable installation afterward. The script is not
included in production runtime images. This focused check does not replace full
release acceptance.

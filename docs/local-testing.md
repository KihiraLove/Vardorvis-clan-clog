# Local acceptance and release-only CI

Run the complete automated suite before pushing or requesting review:

```bash
npm run test:all
```

Only **Node 24 and a running Linux Docker engine** are required on the host.
Windows/macOS users can use Docker Desktop; Linux users can use Docker Engine.
The command works from PowerShell, Bash or another terminal. Host `npm ci`,
PostgreSQL, Bash, Chromium, GitHub credentials and production `.env` files are
not required. Without npm installed, run `node scripts/check-local.mjs` directly.
Use Docker Compose 2.24.4 or newer. A rootless Linux engine may need
`LOCAL_DOCKER_SOCKET` set to its Unix socket path.

The first run downloads/builds the Linux dependencies and Chromium. Later runs
reuse Docker's local build cache. Nothing is uploaded to GitHub or GHCR.
The runner mounts the local Docker socket to manage its disposable containers;
run it only for repository code you trust, on your development machine.

## What runs

1. Script tests, including backup fault injection, package-cleanup planning and
   local-runner isolation checks.
2. `npm run validate`: formatting, ESLint, workspace builds, catalog verification,
   typechecks, all Node tests and documentation links. A fresh PostgreSQL 17
   instance is mandatory; skipped/TODO workspace tests fail the full gate.
3. All Chromium tests, with CI's focused-test protection and retry policy.
4. A production image and a second disposable database: migrations, runtime
   permissions, Nginx routing, auth/review, competitions, large branding uploads,
   preview maintenance, catalog/icon persistence, coordinated backup and recovery
   after database restart. The Traefik configuration is validated as well.

Every run uses unique containers, network and volumes; it publishes no host
ports and does not read your `.env`. Development/production stacks can remain
running. Test secrets are generated independently. The runner cleans up its own
resources after success, failure or a handled interrupt, and removes temporary
image tags while retaining build cache. Cleanup errors make the command fail.
After a machine crash, inspect containers/networks with label `clog.local-checks`
and Compose resources with the matching `clog-checks-*` project before manually
removing them; do not use global Docker prune against a shared machine.

Logs, browser traces/screenshots and `result.json` are saved under
`.data/local-checks/<run-id>/`. A result records the Git revision, but covers the
**working tree**, including uncommitted files copied into the image. Attach the
summary to the PR and record the exact commit tested; local results are review
evidence, not a hosted status check. Existing external Discord/server recovery
acceptance still needs its dedicated environment; this command runs all current
automated repository gates.

For a focused edit, use `npm run validate`, `npm run test:tools`, workspace unit
tests or `npm run test:e2e -w @clog/web` after installing local dependencies.
Plain `npm run validate` alone is not the full acceptance gate and can skip DB
integration tests if `TEST_DATABASE_URL` is absent.

## GitHub usage policy

- Pushes and PR updates run no hosted CI. Use local acceptance for development.
- **CI → Run workflow** explicitly runs the same full command on GitHub, without
  publishing. Use it only when a hosted confirmation is worth the budget.
- Publishing a GitHub Release runs full acceptance, then publishes the unified
  multi-architecture image. Use a main-branch commit and a version tag such as
  `v1.2.3` or `v1.2.3-rc.1`. A tag push or draft release alone publishes nothing.
- Images receive the version tag, `release-<full SHA>` and compatible
  `sha-<full SHA>` aliases. Release aliases preserve the entire manifest graph
  from the existing cleanup policy. There are no per-push packages.
- Successful checks upload no artifacts. Failure evidence expires after one day;
  Buildx record uploads and GitHub-hosted image caches are disabled.
- **Clean up development images** is manual and defaults to dry-run. There is no
  hourly cleanup runner. Review its plan before applying deletion to old images.
- Home deployment remains manual and requires a successful **release-triggered**
  CI run. Deployment no longer creates or promotes package tags.

These workflow changes take full effect when merged to the default branch. Until
then, the old default-branch cleanup schedule still exists. If budget is already
exhausted, disable that workflow in Actions while awaiting merge. Required branch
checks named `validate`, `docker-smoke` or `frontend-browser` must be removed or
reconfigured by a repository admin when adopting this policy; otherwise GitHub
can wait indefinitely for checks that no longer run automatically. Do not mark
missing checks as passed. No release or hosted run is required for ordinary work.

Existing artifacts, caches and packages are not removed by this change. Their
storage usage may remain until expiration or explicit cleanup. Workflow YAML
cannot raise a spending limit or bypass an exhausted account budget; release CI
also needs available hosted-runner budget.

See [deployment](deployment.md) for release operation, and GitHub's
[release event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
for published-release triggers.

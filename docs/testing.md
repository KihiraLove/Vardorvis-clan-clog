# Validation and acceptance

The maintained [current inventory](current-state.md#automated-inventory-and-evidence)
explains test coverage and its limits. Run `node scripts/check-local.mjs` for
complete local acceptance; [local testing](local-testing.md) describes prerequisites,
artifacts, isolation and release-only hosted CI. Test totals come from that run's
reports and exact revision rather than fixed counts in documentation.

The full gate runs script regressions, format/lint/build/catalog/type/link checks,
workspace Node tests with disposable PostgreSQL 17, Chromium, workload measurements,
production image inspection, proxy/API/SQL smoke, runtime failure/drain acceptance
and isolated coordinated restore/deployment scenarios. Skipped/TODO workspace
checks fail the gate. The checks image retains test fixtures; the production image
is independently inspected before smoke injection.

For focused host development, `npm run validate`, `npm run test:tools` and
`npm run test:e2e -w @clog/web` require installed dependencies. Workspace builds
clean `dist` before compiling. Database tests explicitly skip if
`TEST_DATABASE_URL` is missing, so validation alone is not full acceptance.
Build shared workspaces before standalone typechecks.

Use only a disposable PostgreSQL cluster. Runtime-role acceptance needs its
bootstrap/superuser login, CREATEDB and CREATEROLE, creates/removes temporary
objects and rotates cluster-level runtime credentials. Do not point it at a live
stack or run independent suites against the same cluster.

Migration coverage includes fresh/repeated startup, populated prefix upgrades,
checksummed-ledger drift rejection, concurrent serialization and transactional
failure. The 020 → 021 fixture preserves every business table and existing staff
session, rejects unexpected dependencies and verifies old-manifest rejection.
[Recovery acceptance](release-recovery.md) uses complete database/file fingerprints,
restored logins/assets/private proof/encryption, incompatible-image rejection,
credential rotation and compatible controlled-image rollback.

Current browser coverage is Chromium; many frontend tests use fixture responses.
Production smoke uses real proxy/API/PostgreSQL. Full browser-to-production-stack
acceptance, browser support policy, CSP/framing verification, actual Discord guild,
production host TLS/load and published prior-release recovery are tracked in
#102–#104. Preview screenshots and green local tests do not approve those gates.

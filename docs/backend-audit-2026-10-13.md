# Backend, API, Discord bot, database and operations audit

Tracking issue: [#62](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/62).

Audit date: 13 October 2026. Baseline: `9c59118cd77080eb98f31c446c4eaaf535c0d9fd`. Companion frontend issue: #60. Related operational work: #11.

This issue records investigation and a detailed implementation plan. Product fixes are not implemented by this audit. Existing frontend changes are separate. Source links below are pinned to the reviewed commit.

## Scope and architecture

Reviewed API composition/authentication, public and private routes, Discord intake/adapter, RuneLite proof storage and auto review, catalog/review/scheduling/competition stores, migrations 001–014, runtime grants, Docker/Compose/nginx, backup/deployment scripts, workflows and tests.

Current topology is one application container containing nginx, API and optional Discord gateway, plus PostgreSQL and a one-shot owner-privileged bootstrap. The API uses `clog_runtime`; the bot reaches two private API routes and has no direct database access. Uploaded icons, logos and screenshots live outside PostgreSQL. The screenshot volume also contains the clan-key encryption root.

Useful safeguards already present: parameterized value queries; fixed upstream WOM host and redirect rejection; request validation; role/session/CSRF checks; bounded image decoding; file checksums and durable writes; transactional audit/receipt writes; optimistic versions and credit uniqueness; ordered scheduling locks; migration checksums/advisory locking; non-root application execution; and CI gates before image publication. These should be preserved.

## Confirmed findings

### B01 — P1: predictable first administrator credentials (shared with #60)

[apps/api/src/auth.ts:48](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/auth.ts#L48); [apps/api/src/store.ts:41](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/store.ts#L41).

Fresh auth-enabled startup creates the administrator with the known password `admin`. Requiring a password change afterward does not establish who owns that first session. Exposure depends on whether an operator completes setup before making the service reachable.

**Fix/acceptance:** require an explicit one-time bootstrap credential or a local provisioning command; never silently recreate a usable known credential. Fresh installation must fail closed or expose a deliberately secured setup flow. Verify subsequent boots preserve accounts, no bootstrap secret is logged, and completed setup cannot be repeated. Coordinate this fix with #60 rather than implementing it twice.

### B02 — P2: runtime grants default to full DML, and catalog receipts are mutable

[packages/database/src/runtime-role.ts:10](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/packages/database/src/runtime-role.ts#L10) and [packages/database/src/runtime-role.ts:65](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/packages/database/src/runtime-role.ts#L65).

Provisioning enumerates every public table. Anything absent from the owner/read/append-only sets receives SELECT/INSERT/UPDATE/DELETE. Thus adding a table implicitly grants data access on the next bootstrap. `catalog_requests` is absent from the append-only set, although manual, RuneLite and page-creation receipt tables are protected.

**Reproduced on disposable PostgreSQL:** after provisioning, runtime UPDATE and DELETE on `catalog_requests` both returned true; a newly created unclassified fixture table received DML; UPDATE on `audit_events` correctly remained false. This is a database least-privilege gap, not evidence of an unauthenticated HTTP bypass.

**Fix/acceptance:** use explicit per-table/per-view/per-sequence policies with unknown objects denied; protect `catalog_requests`; test the complete effective permission matrix, including INSERT where needed and forbidden UPDATE/DELETE/TRUNCATE/CREATE. Provision twice and test password rotation without broadening grants. Review existing role memberships and inherited/PUBLIC privileges as part of effective access testing.

### B03 — P1: backup can report success without stopping writers

[infra/backup.sh:13](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/infra/backup.sh#L13).

Writer discovery runs in process substitution and masks failures with `|| true`. A failed `docker compose ps` becomes an empty writer list; subsequent dump/archive commands can succeed and publish `COMPLETE` without ever quiescing the application.

**Reproduced with local command stubs:** writer inventory returned exit 1, later dump/archive operations succeeded, the script exited successfully, wrote `COMPLETE`, and never invoked `compose stop`. This verifies orchestration failure handling; it is not a production backup/restore drill.

**Fix/acceptance:** capture and check inventory status separately, verify known writers are stopped, and fail before marking completion when inventory/quiescence is uncertain. Preserve restart behavior on every failure path and report restart failure separately. Test inventory/stop/dump/each archive/checksum/restart failures and lock contention. Verify complete backups through an isolated restore of database, icons/logos, screenshots **and the encryption root**.

### B04 — P2: an idle PostgreSQL connection error crashes the API

[apps/api/src/server.ts:25](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/server.ts#L25).

The production pool has no `error` listener. The installed pg-pool implementation removes the failed idle client and emits an error on the pool; an unhandled event terminates Node.

**Reproduced against the real API entry point:** warmed a disposable API connection, terminated that idle PostgreSQL backend, and observed API exit code 1 with an unhandled error event. In the unified container, the supervisor then stops the other processes too.

**Fix/acceptance:** handle and classify pool errors without logging connection objects/secrets, report unavailable readiness during database failure, and allow fresh connections to recover. Test idle disconnect, active-query disconnect, database restart and shutdown. Preserve uncertain-commit handling; never replay arbitrary writes automatically.

### B05 — P2: migration history is checked in only one direction

[packages/database/src/migrate.ts:21](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/packages/database/src/migrate.ts#L21).

The runner validates checksums only for files bundled in the current image. Applied migrations absent from that image are ignored. It can therefore report success against a newer or incomplete migration history. This does not prove every rollback is incompatible; it means compatibility is not enforced.

**Reproduced:** add a `999_future.sql` ledger row to a disposable migrated schema; `migrate()` succeeds. A regression assertion for rejection currently fails and is explicitly marked TODO.

**Fix/acceptance:** define a supported schema compatibility policy and compare the full applied ledger with the bundled manifest before startup. Reject unknown history by default unless an explicit compatibility contract permits it. Detect gaps/reordered history; retain checksum protection and transaction atomicity. Add bounded connection/lock/statement timeouts for bootstrap, and test populated forward upgrades and approved rollback combinations. Do not edit already applied SQL migrations.

### B06 — P2: bot loses uncertainty when the second attempt is rejected

[apps/bot/src/api.ts:138](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/bot/src/api.ts#L138); [apps/bot/src/handler.ts:64](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/bot/src/handler.ts#L64).

The first submission may commit and lose its response. If the identical retry then gets 401, for example after credential rotation, the adapter throws only the second error. The formatter says “Nothing was saved.” That claim is stronger than the known outcome.

**Reproduced with the HTTP adapter:** first request throws a lost-acknowledgement error, second returns 401; the message falsely asserts nothing was saved. The added regression test is TODO until fixed.

**Fix/acceptance:** preserve whether any attempt had an uncertain outcome and produce an unconfirmed-receipt message in this case. Include a safe correlation/interaction reference for staff investigation. A newly issued Discord command has a new interaction ID, so wording must not imply that reissuing the command reproduces the original idempotency key. Test timeout → successful replay, timeout → 401/403/422, repeated timeout, malformed receipt, and permanent first-attempt rejection.

### B07 — P2: growth limits turn successful historical use into unavailable reads

[apps/api/src/review-store.ts:264](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/review-store.ts#L264); [apps/api/src/xp-store.ts:346](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/xp-store.ts#L346); [apps/api/src/scheduling-store.ts:61](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/scheduling-store.ts#L61).

Review pagination first reads and hashes up to 20,001 matching submissions; more than 20,000 makes the queue return 503. A detail with more than 5,000 audit events also becomes unavailable. XP history returns 503 above 2,000 records, including history added by unchanged imports. Competition/schedule capacity is separately capped, and there is no archival lifecycle.

**Fix/acceptance:** implement bounded SQL/keyset pagination and a deliberate revision/snapshot policy; keep old receipts and audit evidence available. Test both sides of each boundary and concurrent insertion/review while paging. Archive ended schedules through a defined operation if desired; do not silently delete histories to restore service. This extends the capacity findings in #60.

### B08 — P2: expired previews and abandoned assets have no maintenance lifecycle

[apps/api/src/xp-store.ts:139](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/xp-store.ts#L139); [apps/api/src/competition-store.ts:108](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/competition-store.ts#L108); [apps/api/src/proof-routes.ts:129](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/proof-routes.ts#L129).

Previews have expiry timestamps but no routine purge. Error handling correctly retains uploaded files when commit acknowledgement is uncertain, but the promised later maintenance pass is absent. Unreferenced catalog uploads and failed/abandoned uploads can accumulate. Historical referenced branding/proof assets must be distinguished from garbage.

**Fix/acceptance:** a bounded maintenance job with a grace period, database reference checks, dry-run/reporting, and safe restart/retry. Never delete immutable receipts or a file merely because its creating request returned an error. Exercise unknown commit outcomes, active upload races, retained audit references and restart recovery. Coordinate with #60.

## Additional hardening, performance and refactoring work

These are source-supported gaps or improvement candidates, not claims of a demonstrated exploit, outage, or measured speedup.

### B09 — P2: resource budgets and read-path cost

- WOM has a 6.5-second timeout, but calls `response.json()` before enforcing participant/result limits. Add a streaming byte ceiling and per-account/global preview concurrency/rate budgets. Source: [apps/api/src/wom.ts:218](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/wom.ts#L218).
- Login limits are per IP; password hashing has no application-level global queue bound. Discord intake and autocomplete lack explicit per-user/guild budgets. Bound expensive work and surface 429/Retry-After consistently without conflating it with persistence outcomes.
- Public catalog/collection conditional requests compute the complete projection and hash before returning 304. XP rebuilds totals/podium from all snapshots and performs repeated linear lookups. Bot autocomplete and bot readiness load the full active matching catalog. Use revision-keyed projections/caches with cross-process invalidation and bounded size. Sources: [apps/api/src/app.ts:154](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/app.ts#L154), [apps/api/src/xp-store.ts:68](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/xp-store.ts#L68), [apps/api/src/store.ts:197](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/store.ts#L197).
- Benchmark before adding indexes: audit detail filters `audit_events.submission_id`, and proof retrieval checks `submissions.proof_image_id`; neither has a dedicated lookup index in migrations 001–014. Consider `audit_events(submission_id,id DESC)` and a partial proof-image index after EXPLAIN ANALYZE on representative data. Measure row-trigger revision churn during large membership changes.
- Set acceptance budgets using representative catalog/history/participant sizes, concurrency, p95 latency, pool waiting, CPU, memory and query count. No numerical performance improvement was established in this audit.

### B10 — P2: lifecycle, observability and recovery gates

[apps/bot/src/runtime.ts:8](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/bot/src/runtime.ts#L8), [apps/bot/src/index.ts:58](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/bot/src/index.ts#L58), [infra/start-app.sh](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/infra/start-app.sh), [infra/deploy.sh](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/infra/deploy.sh).

Bot stop immediately destroys the client without tracking/draining active interactions. Unexpected handler failures are swallowed. API errors deliberately suppress unsafe driver data but retain little diagnostic classification. Add bounded draining and sanitized error category/code/request or interaction ID metrics; test in-flight commit/response during termination.

The unified deployment couples nginx/API/bot restarts, and optional bot readiness contributes to application readiness. Explicitly decide whether a Discord outage should mark the website unready. A separate container boundary is an option if independent availability is required, not a mandatory rewrite.

Backup content is checked in CI, but there is no automated complete recovery drill. Deployment invokes a preinstalled host helper and mutable host Compose files: record/version the installed infrastructure together with image digest and database version. Rehearse migration failure, unavailable image, credential rotation, process crash, rollback compatibility and filesystem restore. Do not treat an image rollback as a database rollback.

### B11 — P2/P3: simplify duplicated backend responsibilities

- Legacy XP and unified competition imports duplicate preview/replay/diff/write/audit logic and share XP state. Consolidate behind a single domain service while keeping route compatibility and receipt semantics. Put metric classification/skill definitions in one shared owner. Automatic kind detection and page-free future SKILL competitions remain acceptance requirements in #60.
- Transaction boilerplate is repeated across stores. Introduce a small transaction helper only after inventorying isolation level, lock order and uncertain-commit behavior. Preserve explicit domain operations rather than adding a generic repository framework.
- The API uses concrete store types for some route dependencies; expose narrow interfaces like the existing bot/proof contracts to support failure injection.
- Competition activity corrections overwrite result JSON, while competition audit old/new values contain metadata and XP changes rather than complete activity before/after results. Decide and test the retention needed to reconstruct activity corrections.
- Retired OAuth state code/table and nginx callback handling remain despite password-based staff authentication. Remove runtime remnants; decommission persisted objects with additive migrations and documented compatibility.
- Production images copy entire compiled directories including tests. Separate production/test output; verify no fixtures or test entry points ship. Do not delete useful smoke scripts merely because they are tests.
- Documentation contains historical topology/OAuth/pending-feature descriptions and stale test counts. Replace conflicting current guidance with one maintained architecture/operations/test inventory, keeping historical decisions clearly labeled.

## Test-suite review and evidence

Existing tests cover meaningful auth/CSRF boundaries, role restrictions, input validation, transactional rollback, concurrent credit/replay races, scheduling boundaries, world policy, durable files, imports and optimistic conflicts. Most feature database tests create isolated schemas and execute SQL directly; that does not exercise every migration-runner or runtime-role behavior. Docker smoke checks selected grants but not an exhaustive policy.

Audit changes add seven Node tests in:

- `packages/database/src/migration-audit.test.ts`: concurrent fresh migration, checksum mismatch preservation, failed batch rollback, and unknown applied history.
- `apps/bot/src/retry-audit.test.ts`: permanent first-attempt failure matrix, bounded identical retries, and uncertainty after a rejected retry.

Two assertions are explicitly TODO known defects (B05/B06), **not passing correctness checks**. Remove TODO when implementing the fixes; Node TODO does not automatically fail the suite if a future fix starts passing.

Validation performed locally:

- Full freshly compiled Node suite with disposable PostgreSQL 17: **168 tests; 166 pass, 2 known-defect TODOs, 0 unexpected failures, 0 skips**.
- TypeScript compilation/type checking of all workspaces; ESLint; documentation links; bundled catalog validation.
- Actual API idle-disconnect probe and real PostgreSQL effective-grant probe.
- Backup writer-inventory fault injection with stubbed commands.
- The dependency advisory checkpoint from #60 (12 October, unchanged lockfile) returned no advisories; this audit did not infer that absence establishes overall security.

No production data, real Discord gateway, live WOM import, home-host deployment or end-to-end restore was exercised. Docker production-image smoke and browser tests were not rerun for these audit-only backend changes. Source review is broad, but it is not an exhaustive security assessment.

## Ordered implementation plan

### Phase 1 — security and recoverability prerequisites

- [ ] B01: secure first-admin provisioning, coordinated with #60.
- [ ] B02: deny-by-default database grants and complete privilege tests.
- [ ] B03: fail-closed backup coordination and failure-path tests.
- [ ] Restore a representative backup into an isolated stack; verify accounts, credits, audits, XP, schedules, images and decryption.
      **Exit:** unsafe fresh setup is prevented; runtime cannot mutate immutable receipts; no failed backup is labeled complete; restore evidence exists.

### Phase 2 — availability and receipt correctness

- [ ] B04: pool error recovery and sanitized diagnostics.
- [ ] B06: preserve uncertainty across retries and clarify operator recovery.
- [ ] B10: bounded API/bot draining and process-failure tests.
      **Exit:** database restart recovers; uncertain outcomes never produce false success/failure claims; shutdown handles in-flight receipts predictably.

### Phase 3 — migration and deployment compatibility

- [ ] B05: complete ledger validation and explicit supported-schema policy.
- [ ] Add populated 013→014 and later upgrade fixtures, checksum/order/gap tests, transactional failure tests and concurrent bootstrap tests.
- [ ] Bound bootstrap waits; record image/infrastructure/schema versions; rehearse supported rollback and password rotation.
      **Exit:** unsupported image/schema combinations fail before serving traffic; upgrade preserves credits, histories, assets and manual catalog edits.

### Phase 4 — capacity, maintenance and API performance

- [ ] B07: paginated histories/review queue and capacity behavior.
- [ ] B08: bounded cleanup with reference/race protection.
- [ ] B09: provider byte limits, workload budgets, query benchmarks, then measured indexes/projections.
      **Exit:** boundary-sized fixtures remain usable; cleanup preserves evidence and receipts; publish before/after latency/query/memory measurements.

### Phase 5 — architecture consolidation

- [ ] B11: shared competition domain service and authoritative metric classifier.
- [ ] Support page-free future SKILL imports and automatic kind selection with #60.
- [ ] Narrow route interfaces and shared transaction plumbing while preserving lock order.
- [ ] Define activity correction audit retention; remove retired runtime code and production test artifacts; refresh docs.
      **Exit:** old/new route contract tests agree, idempotent replay remains durable, and production output contains only runtime assets.

### Phase 6 — release acceptance

- [ ] CI requires real database tests; introduce a complete runtime-role matrix and upgrade fixtures.
- [ ] Add lifecycle/backup fault injection and an isolated restore job.
- [ ] Run production-image proxy tests, real frontend/API contract flows, load checks and a test-guild Discord smoke test.
- [ ] Convert all known-defect TODOs into ordinary passing regressions; document any intentionally retained limits.
      **Exit:** CI and recovery evidence cover the final implementation; unresolved production-only checks remain explicit.

Keep phases as reviewable changes with their own tests. No existing migration should be rewritten, no history discarded to bypass limits, and no broad refactor should precede the receipt/privilege/recovery tests protecting its behavior.

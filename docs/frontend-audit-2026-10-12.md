> **Historical record:** This document preserves decisions/review evidence at its recorded revision. Current topology, authentication, implemented features and acceptance are maintained in the [current inventory](current-state.md); older pending-feature statements below are superseded.

# Frontend and repository audit — 12 October 2026

Tracking issue: [GitHub #60](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/60).

Reviewed baseline: `9c59118cd77080eb98f31c446c4eaaf535c0d9fd` (PR #58 merge). The initial working tree was clean. This is an investigation and implementation plan; application behavior has not been changed. The local changes add regression coverage, prevent tests from overwriting reference screenshots, and record this report.

## Evidence and limits

Reviewed the public/admin React flows, HTTP adapters, competition/review/XP stores and routes, authentication, upload handling, bot intake, schema/runtime privileges, proxy/container configuration, CI and tests. The four supplied screenshots are evidence of layout/form inconsistencies; they contain no additional instructions.

Validation completed locally:

- All five workspaces typecheck; API, bot, database and domain compile.
- All 5 standalone image-cleanup policy tests pass.
- **161 Node tests passed, zero failures and zero skips**, including integration tests against a newly created PostgreSQL 17 container with no mounted data. The disposable container was stopped and removed.
- **63 Chromium scenarios completed: 58 ordinary passes and 5 expected failures** tied to #60. Playwright reports these as “63 passed”; that does **not** mean the five defects are fixed.
- Ten browser scenarios were added: five passing live-HTTP-adapter checks and five explicit `test.fail` reproductions. An unexpected pass fails CI and requires removing the corresponding annotation.
- ESLint, formatting of changed tests, documentation link checking and the pinned catalog check pass (1,717 items / 124 pages).
- Production frontend build succeeds: one eager JS bundle, approximately **409.86 kB / 121.37 kB gzip**. This is a baseline, not a measured performance improvement.
- The first run encountered Linux native packages in the Windows checkout. Restored the three Windows packages at their lockfile versions, verifying SHA-512 integrity; no manifest or lockfile changed.
- Existing browser fixtures sometimes leave public routes unmocked and produce Vite proxy connection errors even when assertions pass. The new audit fixtures explicitly handle their required routes.
- No production data or deployed session was used. Browser tests use fixtures/preview, while backend integration tests use real disposable PostgreSQL. The combined deployed browser → proxy → API path and a full container rebuild/smoke run remain implementation acceptance gates.
- With explicit user approval, checked npm's public bulk advisory service on **12 October 2026 at 21:47 CEST**: **275 npm-registry package names / 284 distinct locked package-version pairs; no advisories returned**. Includes development and optional dependencies recorded in the lockfile. This check does not cover OS/container packages, undisclosed vulnerabilities, or the application-level security findings above.

## Reported problems and confirmed causes

| ID  | Priority | Finding and evidence                                                                                                                                                                                                                                                                                  | Required behavior                                                                                                                                                                                        |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | P2       | Public layout uses `align-items: start`; the activity list has its own 650px cap. The collection caption belongs to a different vertical area from the scaled game window. See `apps/web/src/style.css:2084`, `App.tsx`, `CollectionLog.tsx`.                                                         | On desktop, activity panel top/bottom align with the actual collection-log frame, excluding its caption. Its list scrolls internally. Preserve normal stacked mobile layout.                             |
| F02 | P2       | `AdminPage.tsx` renders navigation under `!session?.mustChangePassword`, which is true for both null and undefined sessions. Browser reproduction confirms the links remain when signed out.                                                                                                          | Hide all private navigation while checking access, when signed out, after session loss, and during mandatory password setup. Retain server-side authorization.                                           |
| F03 | P2       | `App.navigate` pushes the URL and changes the route immediately. Queue/catalog fetch after mounting; `XpAdmin` repeats the session read already done by `AdminPage`, then loads history. Existing geometry tests protect settings placeholders or a few background pixels, not destination readiness. | Prepare destination code/data in the background, retain current content, then commit a ready route once. Deep links get a stable initial loading shell. Handle cancellation, errors and browser history. |
| F04 | P2       | `.site-button:disabled { cursor: wait }` applies to every disabled control, including pagination boundaries, clean forms and unmet review prerequisites.                                                                                                                                              | Show a wait/progress cursor only during an actual request. Explain disabled action requirements with visible text linked to the control.                                                                 |
| F05 | P1       | `SubmissionEditor` excludes `reason` from dirty tracking. The backend `review-store.ts` also rejects edits when only the reason changes, and submission projections omit the existing `review_reason` column. Toggling hardcore merely makes a claim field dirty.                                     | Save/discard review text independently of item/date/collector/world changes, in either world mode. Persist/reload notes and audit them without creating or moving credit.                                |
| F06 | P2       | Proof acknowledgment is disabled for unsaved claim changes, not for saved hardcore=true. Saved ordinary **and** hardcore claims both pass live-adapter approval tests. Reject and Revoke require a nonblank reason; proof acknowledgment alone does not enable Reject.                                | Preserve the saved-claim proof safeguard, but clearly explain how to enable each action. Test complete positive and negative combinations. Do not remove validation to make every button clickable.      |
| F07 | P2       | `.catalog-editor-layout` uses `align-items: start`; `.page-picker` is capped at 280px.                                                                                                                                                                                                                | Stretch Add item and Item management to equal desktop height, allowing the page-selection area to consume the remaining height. Maintain bounded lists and natural mobile height.                        |
| F08 | P2       | The shared `CompetitionImport` lives inside `.admin-panel` on Scheduling but `.xp-panel` on XP. Input/select styles are scoped to `.admin-panel`; the new browser test reproduces different padding/background/font.                                                                                  | Give the shared form its own reusable field styles, applied consistently in both locations, including focus/error/disabled states.                                                                       |
| F09 | P1       | Manual kind selection is encoded in domain comments, UI state, client signatures, route schema and `fetchCompetition(input, kind, ...)`. Skill lists are duplicated in API and web.                                                                                                                   | Derive kind on the server from canonical WOM metric identifiers and use one domain skill registry. Show detected kind in the preview; remove both selectors.                                             |
| F10 | P1       | Preview sets `create-schedule` for every new unfinished competition. UI and `PgCompetitionStore.apply` both reject an empty page list. Skill metrics do not map to collection-log pages.                                                                                                              | Save future/running SKILL metadata and dates with zero page links and no collection-log opening schedule. Later finished import records XP exactly once.                                                 |

### Pagination and review controls: what was and was not reproduced

The live adapter requests 20 rows. Previous is correctly disabled on page 1; Next is correctly disabled when the response has no next cursor. New tests exercise next → previous cursor navigation and both boundaries successfully. Existing and new tests exercise approval, rejection and revocation successfully when their prerequisites are satisfied.

A saved hardcore=true claim allows proof acknowledgment. Changing the world checkbox makes the claim unsaved, which intentionally invalidates the acknowledgment until Save succeeds. Rejection requires a reason and no unsaved claim edits, but does not require proof acknowledgment. Revoke is available only on approved credit and requires a reason.

Therefore there is no evidence yet of a general handler failure or permanently busy queue in the reviewed build. Keep the user's observations tracked: if the deployed controls remain blocked with prerequisites met, capture the deployed version, queue/detail response, enabled/disabled reason, 401/403/409/timeout status and pending request duration using non-sensitive fixtures. Do not infer a server defect from a wait cursor alone.

## Additional review findings

| ID  | Priority     | Finding                                                                                                                                                                                                                                                                                | Remediation                                                                                                                                                                                                                                                            |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | P1           | First-run auth creates a predictable default administrator password in `auth.ts` / `PgStore.ensureDefaultAdmin`. Forced password change occurs after login; it does not establish that the first person completing setup is the operator.                                              | Require an operator-supplied bootstrap secret or locally generated one-time setup credential; fail closed for an uninitialized public deployment. Preserve existing configured accounts and test restart/concurrent bootstrap. No evidence of compromise was observed. |
| R02 | P2           | `infra/nginx/default.conf:25` grants the 11 MiB multipart allowance to `admin/branding/logo` but omits `admin/branding/hardcore/logo`. Both API routes advertise 10 MiB logos.                                                                                                         | Cover both exact logo routes. Verify an approximately 4 MiB valid image through the proxy in both modes and consistent rejection above the documented limit. API injection tests cannot catch this.                                                                    |
| R03 | P2           | `competition_previews` and `xp_previews` accumulate expiring full snapshots, with no runtime expiry deletion path found. Unreferenced staged assets also mention a future maintenance pass rather than implementing one.                                                               | Add bounded expiry/orphan maintenance with retention metrics; keep audit/receipt records and protect assets after an uncertain commit. Test safe replay after preview cleanup.                                                                                         |
| R04 | P2           | `XpAdmin` owns a second session state, does not clear old errors on successful refresh, and can retain prior private history while refreshed access fails. `CompetitionImport` handles 401/403 locally without notifying the outer admin shell.                                        | Centralize session ownership and distinguish expired authentication from role/business-rule denial. Clear sensitive caches on true access loss. Add recovery tests. This is stale client state, not a demonstrated API authorization bypass.                           |
| R05 | P2           | `PgXpStore.history` returns 503 after 2,000 rows. Repeated unchanged imports also append history. Review queue returns 503 beyond 20,000 matching claims; detail history has a 5,000-event bound.                                                                                      | Add server pagination/retention contracts before hard limits become outages. Preserve append-only audit and durable request receipts. Do not solve capacity by deleting audit history.                                                                                 |
| R06 | P2           | Every XP tracker poll loads participant snapshots, recomputes totals/podium, and performs repeated `rows.find` joins; ETag handling occurs afterward. Catalog/collections likewise load/hash before deciding 304. `AdminQueue` refetches the full catalog on each page/filter/refresh. | Measure first; use indexed Maps, revision-keyed immutable caches or precomputed aggregates, early revision checks, and a shared version-aware catalog cache. Keep coherent snapshots and cross-process invalidation.                                                   |
| R07 | P2           | Activity viewer re-renders all rows every second and constructs multiple `Intl.DateTimeFormat` instances per row. Public polling is duplicated across App, XP, log and activities.                                                                                                     | Reuse formatters and stable formatted dates, schedule updates at lifecycle boundaries, share visibility-aware polling, and use conditional activity reads. Benchmark populated (up to 2,000 competition) views.                                                        |
| R08 | P3           | Legacy XP preview/apply and unified competition preview/apply duplicate reconciliation, authorization, idempotency and identity handling. API/web also duplicate skill and validation declarations.                                                                                    | Share domain skill metadata and stable contracts first; move writes through one reconciliation service while preserving legacy endpoint compatibility until callers are audited. Preserve lock ordering and exact integer handling.                                    |
| R09 | P3           | Unused OAuth-state methods/types/table and Nginx callback special case remain after account auth replacement. Tests still exercise obsolete methods. README/testing docs contain old counts and describe implemented features as pending.                                              | Remove unused runtime paths and obsolete tests after reference checks; update docs. Any schema removal must be a forward migration with rollback compatibility, never an edit to old migrations.                                                                       |
| R10 | P3           | Public bundle eagerly imports all admin screens and preview fixtures. Server production image copies compiled `*.test.js` through entire `dist` directories. Preview mode is deliberately isolated and is not an auth bypass.                                                          | Split admin/preview chunks and decide whether production demo mode is desired; exclude test outputs from runtime packaging while retaining them for CI. Do not delete useful fixtures indiscriminately.                                                                |
| R11 | P2 hardening | Proxy lacks a CSP/frame-ancestor policy; external WOM reads have a timeout but parse the whole response before roster bounds. These are hardening gaps, not demonstrated exploit chains.                                                                                               | Add a tested CSP beginning in report-only if needed and an explicit framing policy; bound upstream response bytes and preview concurrency without widening allowed WOM hosts/redirects.                                                                                |
| R12 | P3           | Browser tests generate screenshots but generally lack reference assertions; most browser flows use preview/mocked APIs. Some snapshots previously wrote to tracked docs. Chromium is the only configured browser.                                                                      | Keep screenshots in `test.info().outputPath` (fixed here), add semantic geometry/interaction assertions and a small real-stack browser suite. Add Firefox/WebKit smoke coverage if those browsers are supported.                                                       |

Existing controls worth preserving include authenticated private image reads, same-origin CSRF and session cookies, password hashing, strict fixed-host WOM URLs with redirects rejected, bounded image decoding, parameterized queries, transactional review/idempotency, and append-only runtime audit grants. The tests exercise many of these controls. This review does not claim the absence of all security defects.

## Detailed implementation sequence

### Phase 1 — Review form and session correctness

- [ ] Add a centralized authenticated session owner and explicit `checking / signed-out / authenticated / expired` states. Navigation and private loaders depend on it. Remove the duplicate XP session waterfall.
- [ ] Model `claimDirty` separately from `reasonDirty` and from `requestBusy`. Provide a saved review-note baseline; do not clear valid text accidentally during unrelated refreshes.
- [ ] Extend the submission wire model/projection with persisted review text using the existing database column where appropriate. Allow a versioned note-only update on pending/approved claims, audit it transactionally, and preserve the existing credit/claim fields. A blank changed note must be intentionally saveable/clearable; unchanged submissions remain no-ops.
- [ ] Keep correction audit reasons distinct from the reason used for Reject/Revoke. Reuse a currently entered reason for a decision without requiring a separate claim edit first. Reject/Revoke still require nonblank reasons.
- [ ] Invalidate proof acknowledgment for changed claim fields/version; allow acknowledgment for either saved world mode. Reason-only changes must not manufacture a claim change.
- [ ] Show action-specific explanations: first/last page, loading, unsaved claim, missing item/proof, missing reason, stale version or lost access. Restrict busy styling to actual in-flight operations.
- [ ] Preserve 401/403/409/timeout handling, no automatic write replay, double-click protection, audit refresh recovery and idempotency.
- [ ] Remove the F02/F04/F05 expected-failure annotations only after acceptance assertions pass normally.

Acceptance: note-only save/discard works for ordinary and hardcore, notes survive reload, discarded notes reset correctly, no credit changes occur, saved hardcore claims approve, reasoned invalid claims reject, approved claims revoke, and anonymous users see no private tools.

### Phase 2 — Automatic competition kind and page-free SKILL imports

- [ ] Move the current 24 supported skill identifiers and display/icon metadata to `packages/domain`; preserve `runecrafting` versus `runecraft.png` mapping.
- [ ] Fetch WOM metadata first and infer `SKILL` for a skill metric, supported all-skill aggregates (`overall`/`total`), or a scope containing only skills. Classify non-skill metrics as `ACTIVITY`; separately validate whether result data/scope is supported. Mixed skill/activity or computed metrics must produce an explicit unsupported-scope message instead of silently dropping XP or coercing fractional data.
- [ ] Make preview input `{ competitionUrl, pageIds? }`; do not trust caller-selected kind for authorization. For a compatibility period, accept old kind only as a checked hint (reject mismatches). Return the authoritative kind.
- [ ] Add a typed metadata-only preview action for future/running SKILL competitions. Store their WOM dates/identity with zero page links, `scheduleId = null`, and no collection scheduling side effects. Keep ACTIVITY page opening rules separate.
- [ ] Update store preview/apply, route schemas, client parsers, UI text, preview client and all existing tests asserting manual kind. Hide page selection for SKILL. Keep metadata-only imports available to moderators and finished XP results admin-only.
- [ ] Validate lifecycle changes at apply time. Future → running remains metadata-only for SKILL; crossing the end requires a fresh finished-results preview. Preserve exact integers, XP correction acknowledgment, idempotency and replay-after-expiry behavior.
- [ ] Ensure future/running skill events appear in the public XP event list without invented totals/podium. Once finished, import results exactly once and keep activity gains out of XP totals.
- [ ] Inspect already imported SKILL competitions with linked opening schedules. Preserve explicit staff schedules until a reviewed migration/unlink action says otherwise; do not silently delete or recreate them.
- [ ] Use an additive migration only if needed. Existing nullable schedule linkage may already support the new state. Never rewrite migration 014.

Acceptance matrix: all supported single skills, aggregate/multiple skills, activity metrics with/without mapped pages, unsupported/mixed data; future/running/finished and boundary changes; admin/moderator/anonymous; stale preview, duplicate apply, corrected results, legacy endpoint compatibility and existing schedule preservation.

### Phase 3 — Ready-before-switch navigation

- [ ] Introduce a route loader registry for queue, catalog, XP/history, schedules, settings, RuneLite settings and accounts. Load only authorized route dependencies; reuse the current session/catalog.
- [ ] Separate requested route from committed visible route. Prefetch on intent or authenticated idle where useful; clicking awaits a complete data snapshot. Use generation IDs/abort controllers so the last requested destination wins.
- [ ] Supply prepared initial data to pages to avoid duplicate mount fetches. Do not mount hidden editable forms merely to fetch data.
- [ ] Retain current content, focus and scroll while loading. On success, atomically commit content, active navigation, history and focus/scroll policy. Handle back/forward/deep-link navigation separately.
- [ ] Keep the current page on failure with an accessible Retry/Cancel status. On access loss, clear private content immediately. Confirm dirty-form handling and avoid applying data loaded under another session.
- [ ] Test delayed success, failure, timeout, rapid route changes, Back/Forward, logout during preload and auth refresh. Measure panel/footer geometry at desktop and 320px.
- [ ] Replace old tests that require destination placeholder forms to appear immediately; remove the F03 expected failure when the new readiness contract works.

### Phase 4 — Layout and reusable fields

- [ ] Put the collection caption in its own layout row and align the activity panel with the scaled `.log-sizing` frame. Use shared CSS grid rows or a measured shared size; do not equate sidebar height with caption-plus-frame height.
- [ ] Make the activity list consume available panel space and scroll internally for zero, few and many competitions. Recompute for responsive scaling/fonts and both world modes.
- [ ] Stretch Add item and Item management panels, then make the item form and page picker flex into remaining space with `min-height: 0`. Keep internal lists bounded for large catalogs, and retain natural mobile stacking.
- [ ] Apply one reusable admin input/label/fieldset style directly to CompetitionImport in both parents, preserving width, focus ring, native validity and mobile touch targets.
- [ ] Add semantic bounding-box assertions (top, bottom, height tolerance), keyboard/touch coverage and stable reference captures at 1440, 1100 and 320px. Existing screenshots alone are insufficient.

### Phase 5 — Security and operational fixes

- [ ] Harden first-run bootstrap before exposing a fresh install.
- [ ] Correct both branding upload proxy limits and add a real proxy regression test.
- [ ] Add bounded preview/asset maintenance with documented retention and receipt/audit preservation.
- [ ] Add paginated XP/review/audit histories instead of capacity-triggered 503 outages.
- [ ] Verify CSP/framing, upstream body limits, error redaction and rate/concurrency limits using targeted tests.
- [x] Check locked npm dependencies against the public advisory service with user approval. Completed 12 October 2026: no advisories returned for 275 package names / 284 package-version pairs. Recheck after dependency changes and before release.

### Phase 6 — Measured refactoring and release validation

- [ ] Consolidate skill metadata, HTTP errors, polling and legacy/unified import reconciliation in separate small changes.
- [ ] Benchmark query count, rows/bytes read, p50/p95 response time, 304 cost and browser render time with a large disposable dataset. Then optimize Maps, revision caching, aggregate calculation and activity timers with before/after evidence.
- [ ] Split admin/preview bundles; compare initial public JS size and navigation readiness after code splitting. Avoid a new code-loading waterfall.
- [ ] Remove obsolete OAuth paths and production test outputs after reference checks; refresh requirements/contracts/testing/operations docs to the final behavior.
- [ ] Run the standard validation, all browsers supported by the project, disposable PostgreSQL tests and Docker smoke/backup-restore checks. Add a real-stack browser flow: login → create claim → note/correct → approve → public shared-page credit → revoke.
- [ ] Review desktop/mobile screenshots and accessibility under slow responses. Deploy only through the project's normal reviewed release process; verify the deployed commit and monitor non-sensitive error/latency metrics.

## Test additions and remaining coverage gaps

Added `apps/web/tests/frontend-audit.spec.ts`:

1. Live-adapter next/previous cursor navigation and boundary controls.
2. Saved ordinary proof acknowledgment and approval.
3. Saved hardcore proof acknowledgment and approval.
4. Reject with a reason, independently of proof acknowledgment.
5. Reviewed approved-credit revocation with a reason.
6. Expected failure: anonymous admin navigation.
7. Expected failure: pagination boundary incorrectly shows waiting cursor.
8. Expected failure: reason-only draft cannot be saved/discarded.
9. Expected failure: route switches before destination data is ready.
10. Expected failure: XP and Scheduling input styles differ.

Five known failures are deliberate issue reproductions, not skipped tests or repaired behavior. Their annotations are located immediately before the failing acceptance assertion so setup failures are not marked expected. Expected failures must be removed as their fixes land; all ten must pass normally before #60 closes.

Changed competition screenshots to per-test output paths. Existing authentication/review/concurrency tests remain intact. Add the phase-specific backend, geometry, delayed-read and real-proxy cases alongside their implementations; do not encode the current manual-kind/page-required behavior as desired future behavior.

Known test-suite weaknesses: browser fixtures and preview business logic can drift from real API contracts; unmocked background requests create noisy passes; no real authenticated full-stack browser gate; tests explicitly require manual kind, which must change; geometry assertions do not currently enforce both requested equal-height layouts; no test verifies large hardcore-logo uploads through Nginx. The operations cleanup script tests run in their separate workflow rather than the workspace test command.

## Completion criteria

- [ ] Every reported problem is resolved or supported by a documented deployed reproduction showing a different cause.
- [ ] All five expected failures are normal passing tests and the new competition/layout/proxy cases pass.
- [ ] Review notes work independently; saved-claim proof and audit/credit integrity remain protected.
- [ ] Automatic kind and page-free SKILL lifecycle behavior are consistent across domain, API, database, preview and both admin entry points.
- [ ] Security fixes preserve existing data and audited history; migrations are additive and deployment/rollback is documented.
- [ ] Performance changes have measurements, and remaining deferred findings have explicit follow-up tracking.

## Pinned source references

- [Logged-out navigation](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/AdminPage.tsx#L182)
- [Immediate route switching](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/App.tsx#L279)
- [Review draft/decision gates](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/SubmissionEditor.tsx#L114)
- [Backend rejects note-only changes](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/review-store.ts#L492)
- [Disabled button cursor](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/style.css#L984)
- [Catalog panel layout](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/style.css#L1377)
- [Public sidebar layout](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/style.css#L2084)
- [Manual competition kind / empty-page gate](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/web/src/CompetitionImport.tsx#L121)
- [Competition preview route contract](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/competition-routes.ts#L34)
- [Unfinished competition page requirement](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/competition-store.ts#L374)
- [First-run account bootstrap](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/auth.ts#L48)
- [Proxy upload size route matching](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/infra/nginx/default.conf#L25)
- [XP projection recomputation](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/xp-store.ts#L66)
- [Legacy OAuth state methods](https://github.com/KihiraLove/Vardorvis-clan-clog/blob/9c59118cd77080eb98f31c446c4eaaf535c0d9fd/apps/api/src/store.ts#L558)

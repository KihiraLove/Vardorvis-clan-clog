# INTEGRATION-01 implementation and review log

Umbrella: [#43](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/43) coordinates [REVIEW-01 #7](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/7), [HC-01 #26](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/26), [UI-01 #3](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/3), [UI-02 #9](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/9), [XP-02 #28](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/28) and [ADMIN-01 #8](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/8).

## Baseline already merged into main

- Frontend PR #33: 2× collection log, original animated Mexicat logo, favicon, skull silhouette styling, one menu per active mode, inline event XP tracker and review UI. Preview mode is **local-only** and must never be called a production review.
- Backend PR #38: public catalog/approved collection projections, independent world-mode uniqueness, admin OAuth session, authenticated durable release flag.
- Bot PR #41: durable pending Discord intake.
- WOM PR #42: atomic event-only imports and public revisioned XP tracker.

## Implemented in this integration branch

- Real review API: \`GET /api/v1/admin/catalog\` (read-only adapter for canonical items), \`GET /api/v1/admin/submissions?status=pending|reviewed&unmatched=true&limit=20&cursor=...\`, \`GET /api/v1/admin/submissions/:id\`, \`PATCH /api/v1/admin/submissions/:id\`, \`POST .../:id/{approve,reject,revoke}\`.
- The new API uses the **same allowlisted Discord server-side session** as settings and XP. Writes require exact-origin and a matching session-derived CSRF token. Bot tokens cannot review. The queued records retain proof and private actor information **only** behind admin authorization.
- A forward-only migration stores an admin display snapshot and action reason in \`audit_events\`. Before/after submission audit snapshots, status transitions and item/mode/date/collector corrections share the same PostgreSQL transaction. Row locks, expected versions and the existing \`submissions_one_credit_per_world\` unique index prevent duplicate approvals; occupied corrections fully roll back. Public collections continue selecting approved rows only.
- The existing merged admin frontend uses these live response shapes; \`date_source=submission_default|collector|admin\` maps to public UI \`submission|claim|admin\`. Queue cursor revisions detect stale pages.
- New PostgreSQL tests cover manual matching, idempotent/competing decisions, same-item independent modes, cross-mode conflict rollback, audit atomicity, failed proof, browser sessions and CSRF.

## Remaining before declaring six-issue acceptance

- [ ] Verify CI validation, disposable PostgreSQL, Docker smoke and Chromium browser suite on every pushed commit.
- [ ] Perform additional full-browser, live-mocked session-to-public-log integration for the new endpoints, including responsive captures against the supplied revised mockup.
- [ ] Manually verify actual Discord credential/OAuth behavior and source WOM availability in deployment; never expose these credentials to public PR CI.
- [ ] Confirm hardcore release setting and public credit polling on a running site after an actual review decision.
- [ ] Review the sample catalog's live missing-item path. [CAT-02 #30](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/30)/[ADMIN-02 #31](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/31) own durable manual icon/item creation and page ordering, not this read-only review adapter.
- [ ] Owner manual acceptance for all six original issues before removing draft status or adding closing keywords.

### Validation

CI supplies \`TEST_DATABASE_URL\` and runs \`npm run validate\`. Preview/testing:
\`npm run dev:web\`; visit \`/?preview=1\`, \`/admin?preview=1\` and \`/admin/xp?preview=1\`. Real admin endpoints are available only with a migrated database and valid allowlisted OAuth configuration; no staged icon upload or catalog editor writes are claimed here.

Avoid merging this PR until tests and manual acceptance are complete. The PR deliberately references #43 and the original six issues **without closing keywords** while still incomplete.

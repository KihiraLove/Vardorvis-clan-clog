# Admin frontend review

> **7 October 2026 revision:** [Mockup revision](mockup-revision.md) supersedes earlier combined HC styling, multi-collector, separate XP/member-table and public Admin-link requirements. It documents current preview behavior and outstanding live API work.

Status: frontend implementation for manual review, 2026-10-06, in draft [PR #33](https://github.com/KihiraLove/Vardorvis-clan-clog/pull/33). ADMIN-01 [#8](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/8) and ADMIN-02 [#31](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/31) are assigned to KihiraLove and remain open. Main is unchanged.

## Run and routes

```bash
npm ci
npm run build -w @clog/domain
npm run dev:web
```

| Route                      | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `/admin?preview=1`         | Submission queue, exact item matching, review and audit history   |
| `/admin/catalog?preview=1` | Add items and save an individual page's item order                |
| `/admin/xp?preview=1`      | Existing WOM competition preview/apply/history interface          |
| `/?preview=1`              | Public collection log showing the preview admin ledger by default |

Preview is explicitly labelled and uses one in-memory catalog/submission ledger across site navigation. It starts with **no approved credits**, four pending claims (two unmatched), and rejected/revoked examples. Pagination uses two rows for review. Sample proof URLs illustrate valid link shapes; they are not real evidence. Reloading, opening another tab or leaving preview resets this ledger and its temporary uploaded icons. No preview operation calls the backend or changes clan data. The separate ordinary/hardcore display examples remain available under Review scenario.

Live routes check `/api/v1/auth/session` before reading private data. They show sign-in or an unavailable state when access cannot be established. They never substitute fixtures silently. OAuth, database review transactions and catalog persistence are still backend work in #4/#7/#30; these screens and the validated HTTP adapter do not implement server authorization.

## Submission review

1. Inspect Pending, Unmatched and Reviewed filters and next/previous pages. A row shows collector, collection date, receipt timestamp, proof link, hardcore claim and canonical identity or raw unmatched text.
2. Open KihiraVD's pending Virtus mask claim. Inspect the saved fields and follow the proof link for manual inspection. Links allow HTTPS Imgur/Gyazo hosts only, open with `noopener noreferrer`, and do not embed or automatically fetch evidence.
3. Check the proof acknowledgment, then approve. Navigate through the site's Collection log link. Virtus mask becomes collected with a red border; its menu includes the skull and `Collected by KihiraVD on 05/10/26 on hardcore worlds`. Duke Sucellus, The Leviathan and The Whisperer share this same identity and credit.
4. Approve Oakheart's ordinary claim. Both credits remain visible. Under Reviewed, correct KihiraVD's hardcore flag with a required reason. The item remains collected with ordinary styling. Revoke individual credits with a reason; only revoking the final approved credit makes it uncollected.
5. Open Iron Fern's unmatched claim. Search by item name or ID and select the exact canonical item. Correct collector/date/hardcore if needed and **save corrections before approval**. The selector includes source/manual provenance and all relevant pages. An unknown item can first be created in Catalog items, then matched on returning to Submissions.
6. Reject a pending claim with a reason, even when unmatched or its proof link is invalid. Missing matches and invalid proof links prevent approval. Reviewed rejected/revoked claims are read-only.
7. Expand Audit history to inspect actor, timestamp, action, reason and before/after values. Collection dates remain calendar dates; timestamps are shown in UTC. Date source distinguishes receipt-date defaults, submitted claims and admin corrections.

Only pending/approved records can be corrected. Corrections to approved credits, rejection and revocation require a reason. Changes use the saved version and session-bound CSRF token. Conflicts reload the current record, discard stale corrections and clear proof acknowledgment; they never auto-submit another decision. Failed reads preserve the last usable queue, disable decisions and offer reload. A known successful write followed by an audit read failure is reported as saved with a refresh problem. Missing/forbidden sessions immediately remove private records and controls.

## Item creation and order

1. At Catalog items, choose a PNG or WebP icon, enter a nonblank name and select one or more existing pages. No game ID is required. Files must be nonempty, at most 2 MiB and decode to 1–512 pixels in each dimension; MIME/header mismatch and undecodable images fail before upload. Transparency and pixel rendering are preserved.
2. Create the item on Vardorvis and Duke Sucellus. It has one server-assigned internal ID, manual provenance, and starts uncollected/non-hardcore on both pages. The initial order appends it to each selected page. Preview icons use temporary browser URLs; live icons must use durable same-origin server assets.
3. In Page item order, drag a row, focus it and press Alt+ArrowUp/Alt+ArrowDown, or use the labelled up/down buttons. Save order explicitly. Save or discard before switching pages. Move buttons also work on touch screens.
4. Confirm only the chosen page changes. Other page orders, canonical identities, collector/date history and hardcore credits remain intact. The saved order is marked as a manual override.
5. Navigate through the site links to inspect the public result, then match and approve a pending claim against the new manual item. All its page occurrences become collected together.

Creation stages a validated asset before the atomic item/membership request. It retains one payload and idempotency key while the form is mounted for retries after an uncertain result; fields remain locked until the same request returns a receipt. Reordering sends the complete membership permutation and expected page version. A stale save reloads the latest order for review, without automatically applying the old arrangement. Membership changes also invalidate page versions. Known successful creation/order saves remain acknowledged if the following catalog read fails.

The UI displays source revision, item provenance, override metadata and page versions. Persisting icons, catalog audits, preserving manual entries/order through source imports, stable identity reconciliation and coordinated database/icon restores still require #30/#10/#11/#13. No durable asset volume or production catalog refresh is added by this frontend work.

## Checks and captures

```bash
npm run validate
npx playwright install chromium
npm run test:e2e -w @clog/web
```

Sixteen new Node tests cover decoded private payloads, corrections, safe proof URLs, icon bounds, exact permutations, API request/receipt validation, CSRF/version/idempotency, shared approval/correction/revocation, manual item creation and private access. Nine new Chromium scenarios cover the complete preview flows, drag/keyboard/touch ordering, 320-pixel layouts, anonymous/forbidden access, malformed proof, stale records/order, uncertain creation retry and shared admin/XP logout. Existing public collection-log and XP tests remain in the same suite.

CI uploads `admin-review-desktop.png`, `admin-review-mobile.png`, `admin-catalog-desktop.png` and `admin-catalog-mobile.png` in the `frontend-browser-review` artifact, along with existing captures and failure traces. Screenshots are implementation review captures, not accepted pixel baselines. All browser evidence uses sample or mocked data.

Manual acceptance still includes visual approval, real mobile/hardware checks and server-backed review/catalog flows once their backend dependencies exist. Keep #8/#31 open for that review; this PR has no closing keywords.

## ADMIN-01 follow-up hardening

The live pending/unmatched/reviewed cards now display **submitted via**
(bot versus manual) and **date source** (submission default, collector supplied,
or admin correction) alongside the collection date. The detail editor uses the
same source labels and limits collection dates to today (UTC).

Proofless *manual* entries are shown as "No proof supplied (manual entry)",
rather than an invalid-proof warning; manual pending approvals still require
explicit checkbox acknowledgment. Missing or unsafe evidence on **bot** claims
continues to block approval. Stale reviews reload current state and clear the
acknowledgment; the known occupied-credit database conflict also displays
an actionable explanation rather than reporting only a concurrent edit.

Validation added: live-HTTP-adapter Chromium tests with mocked endpoints for
manual proofless review and credit conflicts, unit tests for response message
allowlisting and source labels, and PostgreSQL collision rollback checks.
Browser mocks do not replace an actual browser-to-PostgreSQL acceptance pass or
human mobile/visual review. ADMIN-01 #8 stays open until those are accepted.

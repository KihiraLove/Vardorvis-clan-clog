# Browser support and real-stack acceptance

REVIEW-03 R12 / #103 adds an authenticated browser → HTTPS edge → production
Nginx → API → disposable PostgreSQL workflow. The existing fixture suites retain
precise failure, long-content, timing and accessibility coverage alongside it.

## Supported browsers

Targets are current stable Chrome/Edge, Firefox and Safari on desktop, Chrome on
Android and Safari on iOS. Minimum tested layout width is 320 CSS pixels. Old
browsers and embedded webviews are outside this support policy.

The automated matrix uses Chromium, Firefox and WebKit bundled with pinned
Playwright 1.62.1 on Linux. All three run real staff/public workflows, access loss,
slow reads, desktop/narrow geometry and uploads. Chromium/WebKit exercise touch;
Firefox uses keyboard at the narrow width. These are engine tests, not tests of
branded Edge, shipping Safari or physical phones. Supported-device and deployed
host verification remain #104 release checks. See [Playwright browser coverage](https://playwright.dev/docs/browsers).

## HTTPS and isolation

Run `node scripts/check-local.mjs`; no hosted development CI or packages are
needed. Only the disposable checks runner maps `clog.example.com` to its own
loopback. Its test-only TLS edge binds internal port 443, creates a fresh one-day
self-signed certificate, and forwards production Nginx headers/bodies unchanged.
It publishes no host port, uses no public DNS, production certificate or `.env`,
and removes temporary keys at exit. The browser accepts this test certificate;
HTTPS, the actual configured `PUBLIC_ORIGIN`, Secure/HttpOnly/SameSite host-only
cookies and normal CSRF/origin checks remain active. Sessions/cookies are created
by real login. No API response is replaced with sample data.

Browser/API writes create the workflow state. Read-only SQL assertions against
the disposable Compose DB confirm notes, corrections, status/version and audit
sequence. Generated test DB credentials and the proxy smoke's synthetic staff
account never refer to development or production data.

## Required behavior

- UI login → private PNG claim → save a note while a collector correction remains
  unsaved → persist correction → approve → one canonical public credit shared by
  Vardorvis and Duke Sucellus → revoke on both pages. Verify global totals, public
  field boundaries, anonymous proof denial, retained note/audits and post-logout
  proof denial.
- Real moderator creation, mandatory first-password change, genuine role 403
  without session loss, owner disable and private-form/draft/navigation clearing
  on the next unauthorized read. Reload requires sign-in; remove the test account.
- Hold a real catalog read, retain current URL/page and keyboard cancellation,
  then load the real response. Assert equal catalog panels, expanded picker bounds
  and 320px containment. Upload >4 MiB PNGs through both branding routes, decode
  saved logos/favicon and restore defaults. HTTP smoke retains decoder/size/CSRF
  failure coverage. Main integration pages reject CSP violations/page errors.

## Semantic assertions and reviewed references

Acceptance checks actual canonical identity, panel edges within one pixel,
picker/submit bounds, visible/focused controls, usable cancellation, bounded
mobile tooltips, touch and document overflow. Activity/form suites retain their
long-content, scrolling, shared-style, touch-target and slow-font assertions.

Every capture uses `test.info().outputPath`. Per-test/per-engine images, geometry
JSON and failure traces live under the run's `browser/stack/` directory. Reviewed
Chromium references in `docs/browser-references/` are copied from those outputs
after inspection; their manifest records hashes, scope and expected relationships.
Tests never overwrite references. Review image and semantic evidence together
before changing a reference. Dates, synthetic collectors, competition clocks and
engine text rasterization may vary; references supplement the invariant checks.

Chromium/Firefox produce raster captures. Playwright's WebKit screenshot path
unconditionally injects an inline animation-sync stylesheet, even with native
screenshot options. Strict CSP correctly rejects that test-only stylesheet.
WebKit therefore saves accessible-tree snapshots and the same geometry/behavior
assertions instead; it still requires zero CSP violations. CSP is never bypassed
or broadened to accommodate screenshot tooling. Physical Safari visual review
remains part of release acceptance.

## Original audit scenarios and green-run rules

All ten original audit scenarios pass normally. The report guard requires each
by name and rejects skips, expected failures, retries, empty/missing reports and
global errors. It checks ordinary/loading/CSP/stack JSON reports and requires all
three real-stack engines. Historical findings do not permit expected failures.

| Original scenario                                          | Fix and maintained acceptance                   |
| ---------------------------------------------------------- | ----------------------------------------------- |
| Queue traversal/boundaries                                 | #81 cursor/revision regressions                 |
| Saved ordinary approval                                    | #71 prerequisites                               |
| Saved hardcore approval                                    | #71 prerequisites                               |
| Reasoned rejection without proof acknowledgment            | #71                                             |
| Reasoned revoke                                            | #71 and real-stack flow                         |
| Logged-out navigation: former expected failure F02         | #69 central access handling                     |
| Boundary cursor: former expected failure F04               | #71 disabled/busy controls                      |
| Independent note save/discard: former expected failure F05 | #70 ordinary/hardcore notes and real-stack flow |
| Prepared navigation: former expected failure F03           | #74 cancel/history/drafts/delayed reads         |
| XP/Scheduling fields: former expected failure F08          | #77 desktop/320px styling and interactions      |

F01/#75 activity alignment and F07/#76 catalog/picker geometry retain dedicated
passing suites. The full runner records exact-commit browser reports,
`browser-results.log`, `smoke.log`, captures, runtime inspection and recovery
evidence under `.data/local-checks/<run-id>/`. Real guild, public DNS/TLS, physical
devices and final deployment/version verification remain #104 gates.

# Release acceptance and manual launch checklist

REVIEW-02 B02/B05/B06/B10/B11 / #104 collects the final gates. Run development
acceptance locally; use GitHub only for explicitly requested confirmation and
published releases. Packages are still created only for published releases after
automated acceptance. The normal reviewed deployment and `home-production`
environment remain in place.

The live guild and deployed host were not available during implementation. The
operator will perform the checks below manually. They remain pending; local
fixtures, synthetic receipt tests and Linux browser engines do not establish
that a live guild, physical device or deployed host passed.

## Automated gates

From a clean commit, run `node scripts/check-local.mjs` (or `npm run test:all`).
The same command is mandatory in release CI before packaging; no push/PR trigger
or paid development runner is added.

| Gate                     | Required evidence                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual PostgreSQL        | All five workspace Node suites run with a disposable PostgreSQL database; skips/TODOs/cancellations/failures reject acceptance. The runtime role matrix uses real logins and effective table/column/sequence/routine/inherited grants, tests unknown objects and actual writes, and preserves immutable receipts/audits.      |
| Populated upgrades / B05 | Ordinary passing tests cover concurrent migration, changed checksums, partial rollback, unknown future history, missing middle/order validation and a populated 013→014 upgrade with failed-batch recovery. Later upgrades and OAuth retirement retain their integration tests.                                               |
| Uncertain receipts / B06 | Ordinary regressions require identical replay after transport loss and uncertainty followed by 401/403/422; permanent first rejection, malformed receipts, bounded retry and shutdown tests remain in the suite.                                                                                                              |
| Production and recovery  | Inspect the exact production image before injecting smoke helpers; run Nginx/API/DB smoke, branding/private-proof/CSRF checks, lifecycle/backup fault injection and all eleven complete isolated recovery scenarios. Missing scenarios or unsuccessful recovery cleanup fail the report guard.                                |
| Workloads                | WOM parsing, hash admission, Discord budgets and real PostgreSQL projection/query measurements run on bounded representative fixtures. See [budgets](workload-budgets.md) and [public performance](public-performance.md); these measurements do not establish capacity on the deployment hardware.                           |
| Frontend                 | All ten original audit cases pass normally; all four JSON reports reject expected failures, skips and retries. Each real-stack scenario is required in Chromium, Firefox and WebKit. See [browser acceptance](browser-acceptance.md) and its reviewed references.                                                             |
| Dependencies             | Query npm's public advisory service for the complete lockfile, including development dependencies. High/critical findings fail; lower findings are recorded for release review. An unavailable/malformed report fails. The final guard requires a passing report no older than 24 hours, matching the exact lockfile SHA-256. |

`dependencies.json` records the timestamp, lockfile hash, policy and sanitized
package/severity counts. No installation, automatic upgrade or `npm audit fix`
occurs. Zero reported advisories is a checkpoint, not a complete security review.
Re-run acceptance after dependency changes and before release; review lower
severity findings rather than assuming an automated pass accepts their risk.

`acceptance.json` consolidates test counts, required regressions, recovery count,
dependency counts and SHA-256 hashes of its source reports. Its
`automatedStatus: passed` is separate from `launchStatus: manual-checks-pending`.
Keep it with the outer `result.json`, which must show the same revision, success,
no interruption and empty cleanup errors. The runner tests the copied working
tree; a revision field alone does not prove the checkout was clean. Record the
clean exact commit used for release review. Local evidence is not a hosted GitHub
status and must not be presented as one.

## Manual isolated Discord check

Use a separate test application/guild, API database and volumes with synthetic
claims. Set runtime `DISCORD_GUILD_ID` to the same isolated guild as
`DISCORD_TEST_GUILD_ID`; test command registration alone does not change the
runtime guild restriction. Follow [explicit registration](bot-operations.md).
Do not put bot tokens, interaction tokens, raw proof URLs or database secrets in
the acceptance record.

- [ ] Record the tested revision/image, application and test-guild IDs and date.
      Register only `/cc-clog` in that guild; confirm restart does not register
      commands again or remove unrelated commands.
- [ ] Verify current canonical autocomplete, nickname fallback, normal and
      hardcore submissions. Confirm replies are ephemeral and say pending
      review, rather than awarded credit. DMs/other guilds must be refused.
- [ ] Save the numeric interaction ID and returned submission UUID. Check the
      test database for one matching row and pending status, using the read-only
      receipt query in [bot operations](bot-operations.md). Review/approve/revoke
      via the staff UI and confirm the public canonical credit behaves correctly.
- [ ] In the isolated test environment, use a controlled response-drop/delay
      proxy between the test bot and its API to lose a response after commit.
      The standalone bot's `API_BASE_URL` can target that proxy. Confirm its
      built-in identical retry returns the original receipt and produces one row.
      Then reject the retry after an uncertain first attempt: the private reply
      must remain unconfirmed, include only a safe numeric interaction reference
      and never claim that nothing was saved. Reconcile the original receipt
      before starting a new command; a new slash command has a new ID.
- [ ] Hold an admitted response/acknowledgment, stop the test bot normally, and
      verify bounded draining, refusal of new work, the known/unconfirmed receipt
      outcome, and durable state after restart. Restore the direct API path and
      remove fault injection. Keep sanitized outcome/correlation evidence.

The combined app fixes its internal bot/API path; use a standalone **test bot**
for the fault-proxy exercise. Local [runtime operations](runtime-operations.md)
already automate transport uncertainty and shutdown against PostgreSQL with a
gateway fixture. Those results supplement this live exercise.

## Manual host, devices and release review

- [ ] Review the latest clean-commit local evidence and a fresh dependency
      report, including all lower-severity findings and retained limits. Review
      the final PR, use the normal version-tag/published-release process, and
      approve the protected production environment only for the reviewed image.
- [ ] Rehearse an actual published prior release and supported upgrade/rollback
      on an isolated host. Verify off-host backup recovery, encryption-root/file
      restoration and capacity on representative deployment hardware. A rollback
      must satisfy schema compatibility; an image change is not a database rollback.
- [ ] Verify public DNS, valid TLS without certificate bypass, HTTP→HTTPS and
      canonical origin, readiness, CSP/framing headers, staff login/CSRF/private
      proof boundaries and the real public/admin workflow. No test certificate
      or localhost mapping may stand in for the deployed origin.
- [ ] Compare the approved full revision and image digest with the host's
      `.current-release.json`, installed infrastructure checksum and exact
      schema/deploy evidence. Confirm the running container uses that image;
      a mutable tag name alone is insufficient.
- [ ] As the owner, inspect `/api/v1/admin/diagnostics` for bounded work/queues,
      pool waiting and sanitized failure counters before/after a normal workload.
      Anonymous/moderator reads must remain denied. Verify separate Discord status
      monitoring and website readiness during gateway loss. Retain aggregate
      counts/outcomes, never cookies, passwords, tokens or raw private logs.
- [ ] Review desktop and 320px layouts, keyboard focus/cancellation and touch on
      supported real devices/browsers, including shipping Safari. Inspect contrast,
      labels and assistive-technology behavior. Automated WebKit uses ARIA/geometry
      evidence because raster capture injects CSS blocked by the real CSP; it
      does not replace physical Safari visual review.

Record each manual result with revision/image, date, target, operator and a
sanitized evidence reference. Leave failed or unavailable checks pending and
record the reason. Attach the completed record to #104 and PR #105 before launch
approval. #104 remains open until merge; its manual criteria must not be checked
off merely because automated acceptance passed.

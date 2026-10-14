# Workload admission and resource budgets

Issues [#84](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/84),
[#85](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/85) and
[#86](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/86) implement
REVIEW-02/B09; #84 also addresses REVIEW-03/R11. These controls share a bounded
admission primitive and are validated together by [local acceptance](local-testing.md).

## Limits

| Work                                                                   | Global per process    | Account/user                                         | Guild                | Waiting                                     |
| ---------------------------------------------------------------------- | --------------------- | ---------------------------------------------------- | -------------------- | ------------------------------------------- |
| WOM previews, shared across both routes                                | 2 active, 12/minute   | 1 active, 4/minute                                   | —                    | Reject immediately                          |
| Password derives, shared across login/setup/account/moderator creation | 2 active              | Existing database per-IP/account login limits remain | —                    | At most 4 jobs, each waits at most 1 second |
| Discord submissions                                                    | 8 active, 120/minute  | 1 active, 5/minute                                   | 4 active, 60/minute  | Reject immediately                          |
| Discord autocomplete                                                   | 16 active, 600/minute | 2 active, 30/minute                                  | 8 active, 300/minute | Reject immediately                          |

Rate windows last 60 seconds from first admitted use. Every applicable scope is
checked before any capacity is consumed; rejection does not use another scope's
rate allowance. Active work remains counted across window expiry. A release is
idempotent and runs after success or failure. Each scope map holds at most 512
identities; inactive expired entries are reclaimed, never live entries. Unknown
identity churn at the cap is rejected for 60 seconds rather than growing memory
or evicting rate-limited identities. Admission has no per-identity timers.

These are per-process budgets. Restart resets them; replicas multiply them.
Deploying multiple replicas needs an additional shared upstream admission policy.
The database login limiter remains shared and is still checked for every attempt.
The privileged internal bot API remains authenticated; gateway budgets do not
replace protection of its bearer credential or Discord's own limits.

HTTP overload returns 429 with an integer `Retry-After`: one second for active
capacity/hash queue saturation, remaining window seconds for rate limits and
60 seconds for key capacity. Existing per-IP login rejection keeps 60 seconds.
No password, verifier, private input or upstream response body is included in
errors or new diagnostics. Password queues retain at most six bounded inputs;
expiry/close removes waiting jobs, rejects new admission and lets active native
scrypt calls finish. The existing salted verifier format and work factor are
unchanged (about 32 MiB per active derive). API close also closes its hash queue.
Full API/bot/supervisor shutdown coordination remains tracked separately in #89.

## WOM response and cancellation contract

Only `https://api.wiseoldman.net/v2/competitions/<id>` is fetched. Redirects remain
rejected. Each response is limited to **8 MiB of bytes delivered by fetch**, before
UTF-8 decoding or JSON parsing, including chunked, compressed and misleading-length
responses. An excessive declared length is rejected before reading; a missing or
smaller length never bypasses streaming accounting. Oversize/malformed UTF-8/JSON
returns 422 without publishing results. Stalled reads/headers and provider failure
return sanitized 503; provider 429 keeps a valid numeric retry delay capped at
300 seconds (otherwise 60).

One 6.5-second signal spans both metadata and optional all-skill breakdown requests,
including response reads. Disconnecting the HTTP client aborts source work. Stream
cancellation and listener cleanup happen on failure as well as success. A preview
holds its slot until its operation settles; excess previews do not reach WOM or
create a preview. Import/apply and durable receipt replay are outside the preview
limiter, so read overload does not block reconciliation of an acknowledged write.

The existing 10,000-participant validation is also subject to the byte ceiling.
A representative 1,000-player/24-skill result is 1,596,779 bytes and a 10,000-player/
single-skill result is 1,298,026 bytes. A 10,000-player/24-skill fixture is 15,978,781
bytes and is deliberately unsupported by this ceiling. Large unsupported results
fail explicitly; no truncated roster or invented zero results are imported.

## Discord behavior and configuration

The gateway owns one submission budget and one search budget across reconnects.
User keys include guild identity. A deferred private submission is admitted before
calling the API. Both identical HTTP attempts belong to that one admission; the
second attempt is never separately throttled locally. Existing interaction-ID
receipts, correction/version rules and uncertain-commit messages are unchanged.
A denied delivery explains its retry interval and that this delivery was not sent;
it advises checking any earlier unconfirmed receipt before starting another
command. It never asserts that previous attempts saved nothing.

Overloaded autocomplete returns a named retry hint or allows a typed item name.
Selecting the hint cannot submit it as an unmatched item: the handler explains how
to retry without calling intake. Other search failures retain empty suggestions.
Successful admitted searches still fetch the current catalog on every interaction.

The following optional Compose/.env settings change rates within the fixed global
ceilings. They must be positive integers; invalid values fail enabled-bot startup.

```dotenv
BOT_INTAKE_USER_PER_MINUTE=5
BOT_INTAKE_GUILD_PER_MINUTE=60
BOT_SEARCH_USER_PER_MINUTE=30
BOT_SEARCH_GUILD_PER_MINUTE=300
```

Submission values may be at most 120 and search values at most 600. Per-user,
guild and global allowances all apply, so the smallest applicable limit wins.
Concurrency and identity-memory ceilings stay fixed. No command registration,
Discord messages, hosted job or package publication is needed to configure them.

## Reproducible measurements

After building the workspaces, run `node scripts/benchmark-workloads.mjs`.
Local/release acceptance also runs this command and retains `workloads.log`.
Each phase runs in a fresh child process; CPU is process CPU time and peak RSS is
the process high-water mark, including runtime and fixture allocation. Synthetic
WOM responses use 64 KiB stream chunks; samples include parsing/normalization,
without live provider latency. Ten observations per shape use two concurrent
requests. These small samples justify bounds, not production latency guarantees.

Measured on Windows with Node v24.19.0 on 14 October 2026:

| Fixture                                              | Before                                   | Bounded                                         |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| 1,000 players, 24 skills, successful p95             | 68.0 ms                                  | 104.2 ms                                        |
| 10,000 players, one skill, successful p95            | 37.3 ms                                  | 80.5 ms                                         |
| WOM phase peak RSS / CPU (30 previews)               | 149.8 MiB / 1,218 ms                     | 198.6 MiB / 1,235 ms                            |
| 24 simultaneous real scrypt requests                 | 24 accepted                              | 6 accepted, 18 rejected immediately             |
| Successful hash p95 / explicit queue wait p95        | 2,293 ms / native pool wait not observed | 865 ms / 585 ms                                 |
| Hash phase peak RSS / CPU                            | 166.5 MiB / 8,046 ms                     | 102.5 MiB / 1,672 ms                            |
| 1,000 mixed Discord deliveries, ten users, one guild | 1,000 backend calls                      | 350 backend calls: 300 searches, 50 submissions |
| Synthetic admitted Discord work p95                  | 0.092 ms                                 | 0.156 ms                                        |

Streaming adds parsing/buffering overhead; its benefit is bounded input and
admission. Hash latency compares different accepted cohorts under the same offered
burst; rejected requests do no scrypt work. The raw/native pool's internal wait is
not instrumented. Discord's synthetic timings measure local admission/catalog
simulation, not gateway/network/database latency.

A separate required PostgreSQL test uses 1,717 items and 1,717 aliases with 500
autocomplete requests from ten users. It counts real data SELECTs/rows and emits
p50/p95 and CPU/RSS evidence: baseline 500 admitted lookups means 1,000 SELECTs and
1,717,000 rows; admission allows 300, meaning 600 SELECTs and 1,030,200 rows. No
catalog-query optimization is claimed; that remains #87. All counts are asserted,
while host-dependent timings are recorded without brittle pass/fail thresholds.

Tests also cover multi-scope fairness, identity churn/expiry, saturation and
recovery, exact byte boundaries, malformed/stalled streams, client disconnect,
many login IPs, successful/failed authentication, hash-queue shutdown and durable
Discord uncertainty/replay. Live test-guild release evidence remains #104.

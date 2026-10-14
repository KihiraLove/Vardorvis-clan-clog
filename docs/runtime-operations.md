# Availability, shutdown and safe diagnostics

This implements [#89](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/89),
[#90](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/90) and
[#91](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/91), from
[REVIEW-02/B10](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/62).

## Availability policy

Website/API availability is independent of the optional Discord gateway. Database
availability remains necessary for website readiness. Static Nginx liveness alone
does not establish that the application can serve current data or accept writes.

| Probe or process                           | Healthy condition                                                | Failure behavior                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Nginx `/healthz`                           | Proxy process is alive                                           | A proxy crash stops the unified container with failure                                                |
| API `/healthz`, internal port 3000         | API process is alive                                             | An API crash stops the unified container with failure                                                 |
| Public `/readyz`, Docker/deployment health | Database-backed API probe succeeds and API is accepting work     | 503 during database outage/draining; recovers after DB recovery                                       |
| Public `/api/v1/discord/status`            | Enabled gateway and authenticated DB-backed bot intake are ready | 503 with `{enabled:true,ready:false}` during gateway/intake outage; does not change website readiness |
| Same Discord status with bot disabled      | No gateway configured to run                                     | 200 with `{enabled:false,ready:false}`; no gateway probe                                              |
| Internal bot port 3001 `/readyz`           | Gateway connected, authenticated intake available, not draining  | 503 on outage or disabled mode; cached intake probes last at most five seconds                        |
| Internal bot `/healthz`                    | Bot health server alive                                          | Reports configured/connected/stopping state; does not imply readiness                                 |

Readiness checks are bounded to 3.5 seconds; the gateway probe has a 2.5-second
transport deadline. Ordinary probes never latch an unhealthy state across recovery.
Dedicated Discord monitoring should alert on the Discord endpoint, not use it as
the website's load-balancer health check. The public status body contains only
availability booleans. Bot metrics and health ports are never published by Compose.

The supervisor restarts a failed bot **process** without restarting Nginx or the
API. Retry delays are 1, 2, 4, 8, 16, then 30 seconds, capped at 30. Running for
60 seconds resets the next delay to one second. A gateway disconnect normally
uses discord.js reconnection rather than exiting. Repeated bot startup failures
remain visible in logs and Discord health; they do not create a rapid restart loop
or remove a working website. Invalid API/database/auth configuration still fails
the API startup instead of pretending the application is ready.

Nginx and API remain coupled because both are required to serve the site. An
unexpected exit of either, including exit status zero, stops peers and produces a
nonzero supervisor exit. Compose's `restart: unless-stopped` then handles restart.
Docker health reports database readiness; Docker itself does not restart an
unhealthy-but-running container. The deployment script waits for readiness as before.

A separate bot container is unnecessary for this policy: independent child
restart and readiness remove Discord's availability dependency while preserving
the current one-image deployment and coordinated-backup writer inventory. The
container still shares CPU/memory/kernel limits; this is process availability
isolation, not protection against a container OOM or host failure. A future need
for separate resource budgets or deployment cadence would justify another service
and corresponding backup/deployment inventory changes.

## Bounded ordered shutdown

Compose grants the app **70 seconds** before external forced termination. The
supervisor ignores repeated TERM/INT during cleanup, cancels any bot restart delay,
and stops children in this order:

1. Send TERM to the bot and allow at most 37 seconds. The bot immediately refuses
   new interactions and closes new workload admission. It waits at most 35 seconds
   for admitted handlers, including API retries and Discord replies, before
   destroying the gateway once. Its health server also closes within the 37-second
   process deadline. Deadline expiry logs pending interaction IDs and exits 1.
2. Keep API and proxy available while the bot drains, then send TERM to the API.
   Its 20-second process deadline covers HTTP handler/response draining, password
   work and pool closure. No new HTTP work is admitted. Existing responses finish;
   clients retain their original request/idempotency identity for retries. The
   supervisor allows 22 seconds before forced kill.
3. Send QUIT to Nginx for graceful connection close, allowing at most five seconds.

The supervisor's phases total at most about 64 seconds plus short polling overhead,
inside the 70-second Compose window. Overriding Docker/Compose stop timeouts below
that window can preempt draining. A forced child timeout or failed child stop makes
supervisor shutdown fail. Normal operator shutdown exits zero. An unexpected
critical child exit retains failure status after peer cleanup. There is no bot
restart after shutdown begins.

HTTP accounting covers both handler completion and transport completion. A socket
disconnect does not erase a database operation that is still running. Likewise,
an early sent response does not erase asynchronous handler work. Resource close
hooks wait for tracked work before closing the PostgreSQL pool. Newly idle
keep-alive connections are reaped after work completes so an accepted request does
not hold shutdown until the ordinary keep-alive timeout. Active work is not killed
merely to obtain a clean shutdown status. API metrics' `active` value counts work
units (transport and handler), potentially two per request; pending IDs are deduplicated.

Deadlines are failure boundaries, not rollback guarantees. A process kill closes
database connections; PostgreSQL may roll back an open transaction, or a COMMIT
may already have succeeded. Shutdown never translates that ambiguity into
"Nothing was saved." SIGKILL, process crashes and host/power failure cannot drain.
Fatal uncaught exceptions/rejections exit with sanitized diagnostics rather than
continuing a potentially damaged process. Existing database uniqueness and durable
receipt replay remain the source of truth after restart.

## Receipts and acknowledgement

The gateway tracks the entire interaction, beginning before defer and ending after
its reply attempt. An accepted API receipt is recorded as `RECEIPT_KNOWN` with the
numeric interaction ID and stored submission UUID before attempting the Discord
reply. If Discord rejects that reply, `ACK_FAILED` identifies the **known** receipt;
the next reply attempt contains the same receipt instead of downgrading it to an
unconfirmed submission. If both reply attempts fail, operators can still reconcile
the known ID from the log and database. This does not assert that the player saw it.

Without a valid API 200/201 receipt, existing uncertainty rules remain: at most one
identical HTTP retry, with the original Discord interaction ID and body. A later
4xx cannot disprove an earlier commit. `RETRY_REJECTED`, `RETRIES_EXHAUSTED` and
`INVALID_RECEIPT` identify an unconfirmed outcome. An interaction reaching the drain
deadline stays unconfirmed unless a known receipt event exists; expiry does not
invent an approval, collection credit, rejection or successful reply.

## Diagnostics and investigation

API and bot emit structured JSON records with fixed service/event/operation,
allowlisted category/code, numeric queue/status values, and validated correlation
IDs. HTTP requests get a server-generated UUID in `X-Request-ID`; supplied client
IDs are not adopted. API rejection responses expose `X-Error-Category` where the
request reaches the error handler. Existing public error text stays sanitized.
Bot client errors use the same auth/forbidden/validation/conflict/overload categories;
uncertain receipts and acknowledgement failures have separate categories.

No raw Error, stack, SQL/detail/parameters, connection object/URL, request URL/query,
body, header, cookie, password, bearer/interaction token or private proof is logged.
Diagnostic sinks cannot change a receipt result if writing a record fails. Unknown
driver/provider fields collapse to fixed codes instead of being interpolated.

| Category                | Examples                                           |
| ----------------------- | -------------------------------------------------- |
| auth / forbidden        | AUTH_REQUIRED, ACCESS_DENIED                       |
| validation / conflict   | INVALID_INPUT, CONFLICT, DB_REFERENCE, DB_UNIQUE   |
| overload                | OVERLOADED                                         |
| timeout                 | TIMEOUT, DB_TIMEOUT                                |
| database                | DB_CONNECTION, DB_SHUTDOWN, DB_RETRY               |
| dependency / unexpected | UNAVAILABLE, UNEXPECTED, PROCESS_FAILED            |
| uncertain               | RETRY_REJECTED, RETRIES_EXHAUSTED, INVALID_RECEIPT |
| acknowledgement         | ACK_FAILED, with known receipt UUID when available |

Counters use fixed event/operation/category/code keys, never correlation IDs,
users/guilds or private input as metric labels. IDs are retained only for active
work and emitted events; deadline events include at most 32 pending IDs. Counters
are per-process and reset on restart, not a durable audit store. Observe both
supervisor restart events and process counters when investigating recovery.

The owner-only, no-store `GET /api/v1/admin/diagnostics` returns counters plus active
work, password active/queued jobs, preview admission and PostgreSQL total/idle/waiting
gauges. Anonymous and moderator requests are rejected. Bot `/metrics` on internal
port 3001 provides handler/workload counts and counters. Preserve structured logs
with your existing restricted log collector; this change adds no external service,
public metrics port, high-cardinality history or token-bearing output.

For an uncertain delivery, obtain its **numeric interaction ID**, correlate failure,
shutdown and `RECEIPT_KNOWN`/`ACK_FAILED` records, and query the existing durable row:

```sql
SELECT id, status, submitted_at
FROM submissions
WHERE discord_interaction_id = '345678901234567890';
```

A matching row confirms persistence and its current review status; it does not
prove the Discord reply was delivered or the claim approved. Reconcile the stored
receipt before starting a new command: a new command has a new interaction ID and
can create another submission. Absence of a row while an original operation may
still be running does not establish rollback. See [bot recovery](bot-operations.md)
and the existing receipt/backup procedures before making any manual correction.

## Verification and limits

Full [local acceptance](local-testing.md) includes real process SIGTERM during a
locked query and deferred COMMIT, complete receipt response and same-ID replay;
client-disconnect accounting; delayed/failed Discord acknowledgement; interaction
deadline expiry; repeated stop; actual Bash supervisor ordering, bot restart,
critical crash and forced API deadline. Failure/redaction tests exercise unsafe
driver metadata, auth/business/overload categories and bounded metric keys.

Production smoke runs a second disposable app process group against the restricted
runtime role. A local gateway-health fixture replaces only the Discord child;
the supervisor, API and Nginx are the production image. It verifies outage/recovery
and bot restart leave website readiness/API PID intact, ordered clean shutdown and
critical API crash failure. Real bot HTTP/handler code is tested through a local
transport proxy that pauses after database commit, delivers or loses the response,
and proves drain/acknowledgement and same-ID replay preserve the single receipt.
No Discord connection or registration occurs. A live guild/gateway acceptance
remains an explicit release-environment check in #104; fixtures cannot replace it.

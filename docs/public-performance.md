# Public projections and visible-page polling

Tasks [#87](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/87)
(REVIEW-02/B09, REVIEW-03/R06) and
[#88](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/88)
(REVIEW-03/R07) share the following measured implementation. Run the complete
[local acceptance](local-testing.md) before release; no hosted development job is required.

## Cache and revision contract

Migration `020_public_projections.sql` adds five transactional revision counters.
Every process probes PostgreSQL before reusing its own cached value. A cold public
read pins the counter and source queries in one repeatable-read, read-only transaction.
There is no TTL coherence gap: a read that begins after a committed writer observes
the new counter; a read concurrent with that commit may finish its coherent older snapshot.
Rollbacks expose neither the source change nor its revision. Failed probes fail the
request instead of serving a cached success. Database reconnection retains the same rule.

| Projection              | Invalidating tables                                    |
| ----------------------- | ------------------------------------------------------ |
| Catalog                 | items, pages, page_items, catalog_state, game_item_ids |
| Approved collections    | submissions, items                                     |
| Matching names/aliases  | items, item_aliases                                    |
| XP totals/events/podium | xp_events, wom_competitions, xp_state.version          |
| Activities              | wom_competitions                                       |

Statement triggers cover INSERT/UPDATE/DELETE/TRUNCATE, including owner imports and
archival/restore. History-only `xp_state.history_version` appends leave tracker data
reusable. A trigger-disabled bulk restore must restart application processes before
serving traffic; reusing process caches across a database restore is unsupported.
Private receipts, previews, optimistic import revisions and authorization remain independent.
HTTP projection ETags are opaque, separate from the original XP import revision.

Each store retains one deeply frozen result and its serialized JSON per projection;
the public projection loader shares a same-revision in-flight load. Revisions are
not accumulated in a map. Active loaders are bounded by the existing connection
pool and statement deadline. Existing row caps still apply: 10,000 active items,
2,000 pages, 50,000 slots, 20,000 credits/aliases and 2,000 all-time XP events.
Raw imported XP source snapshots are discarded after aggregation. Identity Maps
replace repeated XP row searches. Matching shares one immutable item/alias array
between autocomplete and submission resolution, with alias construction through a
Map. On a miss, its revision and both bounded lists come from one SQL statement,
including in READ COMMITTED intake transactions. Intake reads matching data before
its submission writes and never caches uncommitted catalog edits.

Warm catalog, collection, XP and activity reads each issue one counter SELECT plus
BEGIN, SET LOCAL and COMMIT. The 5-second statement timeout bounds each query.
Warm 304s avoid rebuilding, hashing or serializing the large source projection.
Counter updates add a short shared-row write dependency per resource; measure
writer contention before adding replicas or increasing workload limits.

Public settings and both branding variants use their existing independent revisions
for conditional reads. All public endpoints use `max-age=0, must-revalidate`.
Private endpoints retain no-store. Activities use a **weak** metadata ETag because
the response clock changes independently; every 200/304 includes a fresh
`X-Server-Now`. Clients retain metadata identity and update the clock, including
when browser revalidation exposes a cached body as 200. Missing 304 clock headers
fail the refresh. Public log catalog/credits and legacy XP multi-resource snapshots
still validate and commit as a complete pair; a failed/canceled read never partially
publishes new data or cache entries.

Admin review paging/filtering reuses the current authorized catalog snapshot.
Explicit refresh, successful writes and remounting load it again. Every queue page
still makes an authorized private request. External catalog edits become visible
on that explicit refresh; stale catalog write versions still conflict on the server.
This small view cache is destroyed with the private route/session.

## Browser scheduling

Settings, ordinary/hardcore branding, log, XP and activities share one 25-second
visible-page cadence. Requests keep their own conditional validators, errors and
last good values. Hidden pages stop the cadence and abort active requests; tab
return refreshes each resource, coalescing repeated refresh signals. A 10-second
deadline releases stalled slots even if a client ignores cancellation. Last
unsubscribe removes the interval/listener; late results cannot update an unmounted view.
Failed settings refreshes retain the last confirmed world availability and selected
world; an explicit successful disable still returns the view to ordinary mode.

Activity dates use one cached Intl formatter and memoized labels/rows. A single
timeout targets the next start/end boundary, with start inclusive and end exclusive.
There is no per-second render timer. Hidden pages cancel that timeout and catch
up on visibility return. Very distant boundaries are safely chunked at the browser's
maximum timeout. Current server-clock offsets apply to both boundary scheduling
and status. Timezone changes take effect on reload.

## Measurements

The committed [raw measurements](public-performance-measurements.json) include all
query counts, returned row/JSON byte totals, CPU, peak RSS, pool waiting and plans.
Captured locally on 14 October 2026 with Node 24, PostgreSQL 17 and Chromium in Linux
Docker. Baseline code is `39c62fab26a16b5e676de9ffeb5715d77407a70b`, migrations 001–019;
after uses migration 020 and this change. These small samples support the design,
not production latency promises. The database byte metric serializes returned rows;
it is not PostgreSQL protocol/network byte accounting. CPU/RSS cover Node, not the DB.

Primary fixture: 1,717 items and aliases, 124 pages, 10,000 memberships,
100,001 submissions (1,000 approved), 100,001 audit events, 1,000 SKILL plus 1,000
ACTIVITY competitions, and 1,000 imported events with 100 participants each.
Each HTTP phase warms once then records ten sequential in-process API samples.

| Operation                                   | Before p50 / p95 ms | After p50 / p95 ms |
| ------------------------------------------- | ------------------- | ------------------ |
| Catalog 200                                 | 41.55 / 56.50       | 3.25 / 4.66        |
| Catalog 304                                 | 36.52 / 51.79       | 2.22 / 5.73        |
| Collections 200                             | 6.89 / 20.56        | 3.53 / 5.66        |
| Collections 304                             | 4.96 / 8.09         | 2.93 / 4.85        |
| XP 200                                      | 348.85 / 474.44     | 3.92 / 9.24        |
| XP 304                                      | 315.20 / 416.89     | 2.47 / 5.05        |
| Activities 200                              | 16.30 / 24.14       | 3.54 / 4.24        |
| Activities 304                              | unavailable         | 2.88 / 4.94        |
| Autocomplete, includes first cold load      | 10.70 / 31.39       | 7.22 / 57.11       |
| Twelve-reader catalog burst, pool size four | 290.77 / 323.12     | 10.56 / 30.17      |

Across ten reads, catalog returned rows fall from 118,420 to 10, collections from
10,000 to 10, and XP from 30,010 to 10. Returned DB JSON bytes fall respectively
from 4,441,550 / 1,408,940 / 72,071,660 to 500 per phase. XP 304 CPU falls from
3,785 to 27 ms per ten requests. Process high-water RSS across all phases falls
from 363 to 196 MiB, including fixtures/runtime allocation. Burst pool wait p95
falls from 231 to 27 ms. All 304 bodies remain empty. The fixed transaction round
trips increase collections' SQL command count from one to four per request while
removing its repeated row transfer/serialization; this is an explicit tradeoff.

Autocomplete reduces transferred rows/bytes, but its cold p95 regresses in this
sample and matching still scans the cached array. No autocomplete p95 improvement
is claimed. A second fixture adds 10,001 history receipts: paged history remains
two SELECTs and 22 rows/read, p50/p95 2.65/10.08 ms before and 2.27/6.65 ms after.
Its code/index is unchanged; this is regression evidence rather than a new history
cache. Those extended before/after measurements shared the local DB concurrently;
timing differences include contention. Larger history/participant plans are also
covered by [XP history](xp-history-pagination.md) and workload tests.

The 10,000-membership insert previously advanced the catalog revision 10,000 times
and took 4,001 ms in the primary sample. Statement transition tables now lock
affected pages in identity order and advance each page once, with one catalog-state
advance per statement (742 ms). UPDATE includes both old and new pages; DELETE
and TRUNCATE also invalidate. Existing page edit conflicts remain protected.

EXPLAIN ANALYZE on the proof lookup previously scanned 100,001 submissions,
filtered 100,000 rows and touched 1,821 buffers (17.44 ms). A rolled-back candidate
partial index used two buffers (0.104 ms); migration 020's partial index used two
buffers (0.092 ms). This is the only added lookup index. The dense submission-audit
lookup already uses a backward primary-key scan (21 rows, three buffers, 0.082 ms);
the existing migration 017 `audit_submission_page` index covers sparse/deep lookups,
with asserted plans in the review pagination tests. No duplicate audit index is added.

At 2,000 rendered activities, Chromium's formatter instrumentation records one
constructor and 4,000 date formats after, with zero extra formats in three idle
seconds or sixty hidden seconds. The corrected baseline fixture records 12,004
constructors / 12,000 formats at load, 36,010 / 36,000 after three idle seconds,
and 48,013 / 48,000 after three hidden seconds. Hidden request volume is zero
in both sampled windows; the after test covers a full minute and confirms all
seven resources revalidate on return. Load measurements are 2,643 ms before and
2,554 ms after; no load-time guarantee follows from one sample. Formatter work
over the probe falls from 4,508 ms construction + 1,140 ms formatting to 22 + 13 ms.
The baseline hidden window is shorter because repeated full renders made a full
minute probe impractical. New tests also verify exact boundaries, recovery/world
selection, conditional identity, stalled cancellation and unmount cleanup.

## Reproduce

`npm run test:all` builds the current code, runs PostgreSQL invalidation/concurrent
commit/rollback/cache-bound tests, captures `projections.log`, runs the 2,000-row
browser test, and verifies Nginx/runtime-role conditional reads and cross-instance
invalidation without changing receipts. Evidence stays under the run's local directory.
For a disposable test DB after building, run:

```bash
PROJECTION_BENCH_DISPOSABLE=true TEST_DATABASE_URL=postgresql://... node scripts/benchmark-projections.mjs
```

The script creates/drops a random schema and never targets production. To compare
the baseline, run the same script with baseline compiled code and migrations 001–019
in an isolated checkout/container. `PUBLIC_PERF_BASELINE=true` enables the short
measurement-only browser probe; ordinary acceptance always enforces the optimized
assertions. Keep before/after environment and fixture shape identical. Existing
capacity limits, release-only publishing and independent shutdown/recovery tasks
remain as documented; this change does not increase supported ledger capacities.

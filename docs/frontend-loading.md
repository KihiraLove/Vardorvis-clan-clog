# Public entry, staff loading and explicit preview

Implements [#101](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/101),
from REVIEW-03 R10, preserving the [prepared navigation contract](admin-navigation.md).

## Entry boundaries and demo decision

The public entry loads the log, activity/XP viewer, shared validators and HTTP
adapters. It loads no staff screen or preview fixture. `admin-entry.tsx` is one
separate staff chunk containing login, review, catalog, settings and XP import
screens. Keeping these modest screens together means ordinary staff navigation
does not introduce a new per-screen code request after authorization/data reads.
Shared adapters stay in the public graph so session and route reads can begin
without waiting for screen code. No session/private request occurs on the public
homepage merely because those adapters exist.

Production demo mode is intentionally retained at explicit `?preview=1` URLs for
review/support. It is labelled sample data and selected only by that parameter or
an explicit preview button. It never activates automatically after a live read
failure. `preview/runtime.tsx` loads its isolated clients/fixtures on demand;
public preview does not load staff screens or contact live API endpoints. Preview
staff screens use the same separate staff entry. The shared sample ledger survives
internal preview navigation; leaving preview disposes its resources, and reload
or re-entry creates fresh state. Server authorization remains independent.
Fixtures remain available to Node/browser tests and the checks image.

## Readiness and failures

Cold live staff entry begins session checking alongside the staff code request.
Only an authenticated session starts destination reads. Those reads run while
code downloads; they transfer once into the existing cancellable loading shell.
There is no second session/catalog fetch caused by mounting the downloaded screen.
The shell owns its existing read deadline, Cancel/Retry, role gates and access-loss
cleanup. Failed session checks retain the existing access error/retry UI.

Within staff pages, destination code/runtime preparation joins authorized data
preparation under the same abort generation. Only successful preparation can
commit URL/history and the visible page. Current forms, focus and drafts remain
until then, including dirty-form confirmation and in-progress-write protection.
There is no private route-data cache beyond the mounted shell: prefetched entry
state is consumed once and released, and access loss cancels work and clears it.

An import fetch cannot always be stopped after it begins. Cancellation prevents
its late result from changing the route or activating a sample runtime; abandoned
preview resources are disposed. A later explicit navigation can reuse successfully
loaded code. Failed chunks offer **Reload page** to fetch the current hashed assets
in a fresh document/module map. Failed ordinary reads keep **Retry navigation**.
Code failures during navigation preserve the current view and URL and allow Cancel;
a cold deep-link failure shows no private forms. A reload can discard local drafts,
so it is an explicit user action. Nothing automatically replays staff writes.

## Build guards and measurements

Every Vite build walks the complete static import graph and rejects staff screen
or preview modules in the initial entry. It also enforces **320,000 raw JS bytes /
100,000 gzip bytes** across that graph, including shared chunks. This is a
regression budget, not a claim about the actual proxy's compression settings.
The generated `.data/local-checks/web-bundle.json` lists every output chunk,
its modules, initial/dynamic ownership and bytes. It is test evidence and is not
copied into the public web directory or production runtime.

Before #101, revision `22db88c` loaded **437,533 raw / 129,733 gzip JS bytes** on
the public page, including all staff screens and fixtures. The maintained
[measurement snapshot](frontend-loading-measurements.json) records the same
production-build Chromium harness before/after this change. It reports public
bytes and cold catalog deep-link/warm staff navigation readiness, with controlled
400 ms session/catalog response delays. Readiness means visible enabled destination
controls, not just a completed network request. Gzip uses the same Node zlib defaults.

| Measurement                                     |  Before |   After |
| ----------------------------------------------- | ------: | ------: |
| Initial public JS bytes                         | 437,533 | 301,993 |
| Initial public JS gzip bytes                    | 129,733 |  93,982 |
| Public controls ready                           |  594 ms |  562 ms |
| Cold catalog deep link, delayed session/catalog | 1148 ms | 1166 ms |
| Warm account navigation                         |  111 ms |  104 ms |
| Warm catalog navigation, delayed catalog        |  903 ms |  934 ms |

One sample per case; raw/gzip bytes decrease 30.98% / 27.56%.

Timing samples are local observations, not a production latency promise. Extra
entry/request overhead can affect cold staff entry despite the smaller public
download. Visiting every mode still downloads the staff/preview code and some
additional routing machinery. The deterministic performance assertion holds the
actual staff chunk response and proves the session and private catalog request
start before it is released; resolved data is consumed once. It guards against a
code → session → route-data waterfall without depending on a noisy millisecond limit.

## Acceptance and limits

The full local gate runs the existing Chromium scenarios plus
`npm run test:loading -w @clog/web` against a built Vite production preview. The
loading suite covers cold/deep and warm readiness, code/data overlap, cancellable
initial reads, failed chunks and explicit reload, late cancelled preview downloads,
retained live content/URL, anonymous access and preview fixture/API isolation.
Reports/captures use per-test output paths. The normal prepared-route/session/
draft/history/mobile regressions continue to run without expected failures.
Geometry checks wait for the deferred layout to mount before measuring it.
The full runner sets `CI=true`: browser retries retain diagnostic evidence, but
`failOnFlakyTests` makes a test that succeeds only on retry fail acceptance.

Loading acceptance uses fixture HTTP responses behind the production frontend
build. Production proxy CSP/framing acceptance is #102; complete browser → proxy →
API → PostgreSQL acceptance and browser support policy are #103. External release
and deployment checks remain #104. This task does not claim those gates passed.

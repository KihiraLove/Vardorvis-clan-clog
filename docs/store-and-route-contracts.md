# Store transactions and route dependency contracts

This inventory records the current persistence and HTTP boundaries for
REVIEW-02 B11 (#95 and #96). Domain decisions remain in their named methods;
there is no generic repository, automatic write retry or global lock manager.

## Transaction inventory

All writes below use PostgreSQL READ COMMITTED unless stated otherwise. A SQL
statement outside an explicit transaction uses PostgreSQL's statement snapshot.
No listed API store automatically retries a transaction after a driver failure.
Database constraints, trigger-driven projection counters and append-only audits
remain authoritative. The runtime role cannot modify migration or owner-only
maintenance state; see [database provisioning](deployment.md).

| Store/operation                              | Isolation and locks, in acquisition order                                                                                                                                                                                                                                                         | Conflict, receipt and acknowledgement rules                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog reads/writes (`PgCatalogStore`)      | Reads use REPEATABLE READ READ ONLY. Writes acquire catalog/import advisory transaction lock `74261005`, then operation-specific item/page/asset row locks. Multi-item locks are ordered by ID; page reorder locks follow category order. Removing a page locks its member items before the page. | Catalog/page revisions are checked inside the write. New-item/page actor/key receipts, membership changes and audits commit together. Named methods retain their own validation.                                                                                                                   |
| Manual intake (`PgReviewStore.createManual`) | Actor/key advisory transaction lock → active item FOR SHARE → submission/credit insert. Staff backfill bypasses page scheduling.                                                                                                                                                                  | Exact-payload receipt replay is checked under the key lock. The per-item/world approved-credit unique index arbitrates races; its violation maps to 409. Audit, screenshot reference, claim and receipt are atomic.                                                                                |
| Review mutation (`PgReviewStore.mutate`)     | Submission FOR UPDATE → selected active item FOR SHARE for approval/correction.                                                                                                                                                                                                                   | Submission version is authoritative. Unique-credit errors retain their domain 409 mapping. Review acts on an existing historical claim; it does not acquire the intake scheduling gate. Mutations use optimistic versions rather than creating a new replay-key protocol.                          |
| Review queue/detail                          | REPEATABLE READ READ ONLY, local five-second statement timeout; no write locks.                                                                                                                                                                                                                   | Queue/audit revision, cursor and data come from one snapshot. Missing detail returns null after completing the read transaction.                                                                                                                                                                   |
| Legacy XP/unified competition reconciliation | Preview uses REPEATABLE READ with a saved token. Apply: scheduling settings FOR UPDATE → XP singleton FOR UPDATE → actor-bound preview FOR KEY SHARE → registry reads and, for new ACTIVITY schedules, selected pages FOR SHARE in ID order.                                                      | Both protocols retain exact decimal arithmetic, canonical scope, roles, revision checks and negative-XP acknowledgement. Results/schedules/audits/receipts commit together. Replays precede preview expiry; actor/key conflicts return 409. See [import reconciliation](import-reconciliation.md). |
| XP history and public projections            | REPEATABLE READ READ ONLY; history/projections set a local five-second timeout. Cache misses load under the same snapshot as the revision.                                                                                                                                                        | No domain write, counter increment or write retry is introduced by the cache. Cached immutable data and conditional HTTP contracts remain unchanged.                                                                                                                                               |
| Scheduling                                   | Reads use REPEATABLE READ READ ONLY. Writes lock scheduling settings FOR UPDATE, then selected active pages FOR SHARE in ID order.                                                                                                                                                                | Schedule revision, enforcement changes, window/page edits and full-state audit commit together.                                                                                                                                                                                                    |
| `PgStore` accounts                           | Account create uses unique username/administrator constraints; update locks through the version-checked UPDATE; moderator management locks the target account FOR UPDATE. Session invalidation and account audit are in the same transaction.                                                     | Duplicate usernames and stale credentials retain their explicit domain mappings. Bootstrap uses an atomic insert/unique administrator invariant and never overwrites an existing account.                                                                                                          |
| `PgStore` Discord intake                     | Scheduling FOR SHARE → active item FOR SHARE → unique Discord interaction insert. A losing insert waits for and reads the winner's durable receipt.                                                                                                                                               | Exact interaction/payload replay; changed payload is 409. Matching uses a statement-coherent projection. The caller retains unconfirmed-write semantics across failed retries; see [runtime operations](runtime-operations.md).                                                                    |
| `PgStore` settings                           | Site-settings singleton FOR UPDATE; optimistic revision.                                                                                                                                                                                                                                          | Stale revision explicitly ROLLBACKs and returns null; successful setting/audit update commits once.                                                                                                                                                                                                |
| RuneLite proof intake (`PgProofStore`)       | Scheduling FOR SHARE → RuneLite settings FOR SHARE → clan key FOR SHARE → request-key advisory transaction lock → canonical item FOR SHARE. Auto-approval has its own SAVEPOINT.                                                                                                                  | Request receipt, image reference and audit are atomic. Only the named approved-credit collision rolls back to the savepoint and leaves the claim pending. Other errors abort. An uncertain receipt never authorizes deleting a saved proof file.                                                   |
| Branding / clan key / RuneLite settings      | Each locks its singleton FOR UPDATE. Matching-mode saves lock RuneLite rules, then the clan key; both revisions, states and audits commit together.                                                                                                                                               | Domain validation, key encryption and version errors stay explicit. File preparation precedes persistence and reference-checked maintenance handles abandoned files.                                                                                                                               |
| Owner lifecycle archive                      | Reads use REPEATABLE READ READ ONLY. Owner write: scheduling FOR UPDATE → XP singleton FOR UPDATE → target competition/schedule FOR UPDATE.                                                                                                                                                       | Ended-only archival, reason/actor audit, capacity/revision checks and retained results/receipts. Explicit no-op/conflict rollback paths remain owner-controlled. Runtime routes have read access only.                                                                                             |
| Owner migration/catalog/taxonomy             | Migration/catalog/taxonomy operations use advisory transaction lock `74261005`; migrations validate the immutable ledger and commit each migration's SQL and ledger entry together.                                                                                                               | Owner/bootstrap connection lifecycle and failure reporting remain explicit; the API helper is not imported by database tooling.                                                                                                                                                                    |
| Owner runtime-role provisioning              | Advisory transaction lock `74261011`; privilege reconciliation and complete effective-policy verification occur before commit.                                                                                                                                                                    | Password/grant failures roll back. No runtime fallback grant category exists.                                                                                                                                                                                                                      |
| Owner preview/asset maintenance              | Preview maintenance holds its own session advisory lock, deletes bounded expiry batches using FOR UPDATE SKIP LOCKED and commits each batch. Asset maintenance uses schema-scoped session/transaction advisory barriers and committed retirement checks around filesystem work.                   | Dry runs, bounded batches, durable retirement and filesystem ordering remain explicit. These are not callback-style API transactions. See [preview maintenance](deployment.md#expired-xp-and-competition-preview-maintenance) and [asset maintenance](asset-maintenance.md).                       |

## Shared plumbing and its limits

`apps/api/src/transaction.ts` owns one checked-out pool client and one
BEGIN/action/COMMIT sequence. Its three explicit modes retain READ COMMITTED
writes, REPEATABLE READ previews and REPEATABLE READ READ ONLY snapshots. It
handles rollback and releases the client once. Stores retain SQL, lock order,
savepoints, revisions, receipt decisions and domain error mapping.

The verified common paths now use it: catalog's existing transaction wrapper,
manual/review operations and reads, import reconciliation, scheduling, XP
history and public projections. Return from a callback, including a replay or
missing read, completes COMMIT before the public method resolves. The callback
must not issue BEGIN, COMMIT or a top-level ROLLBACK, perform post-commit side
effects, or return a client to the pool. Nested work must use the supplied
client; it must not nest this helper and acquire another pool connection.

When an action fails, rollback is attempted. If rollback also fails, the
original action error is preserved and the connection is discarded. If COMMIT
fails, the remote transaction may already be durable: the original COMMIT error
propagates, the connection is discarded even if cleanup succeeds, and the
helper never runs the action again. Transport and domain receipts determine
how to reconcile uncertainty; an error is not proof of non-persistence.

Other `PgStore`, proof/savepoint, singleton settings and owner maintenance
transactions remain explicit in this bounded refactor. Their existing special
return/error/filesystem behavior is inventoried above rather than folded into
a new framework. Future conversions must prove the same semantics first.

## Route dependency inventory

`apps/api/src/route-services.ts` exposes structural contracts. `Pick` types
retain existing domain method signatures while excluding private pool state and
unrelated methods. The competition interface also excludes the reconciler's
internal legacy-protocol switch. Production `createApp` composition accepts the
actual PostgreSQL/filesystem classes through normal TypeScript assignability;
no unsafe cast is needed for either production wiring or new failure doubles.

| Consumer                             | Required contract and responsibilities                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App public routes                    | `ApplicationStore`: public catalog/collections/optional serialized projection plus the auth and bot operations wired by the app. Readiness and public settings remain injected callbacks. No owner readiness, retired OAuth-state or pool operations are exposed by this composition type.           |
| Authentication/account/site settings | `AuthStore`: bootstrap; session lookup/create/delete; current account/login limit; account list/create/update/optional moderator management; site settings read/write. Current sessions, CSRF, setup and roles remain production middleware. Clan key settings retain their existing `ClanKeyStore`. |
| Discord intake                       | `BotStore`: `botItems` and `submitClaim` only. Existing dedicated bot-token authorization remains in the route.                                                                                                                                                                                      |
| XP public/admin                      | `XpPublicStore`: tracker/optional serialized snapshot. `XpAdminStore`: preview/apply/history. The established `XpStore` remains the composition contract when both are installed.                                                                                                                    |
| Review                               | `ReviewRouteStore`: manual create, paged queue/detail and versioned mutate. The shared private catalog endpoint belongs to app composition, not this route contract.                                                                                                                                 |
| Proof/RuneLite and manual upload     | Existing `ProofStore`, `ProofFiles` read/save and `ManualReviewStore.createManual`. No catalog/account management or filesystem deletion dependency.                                                                                                                                                 |
| Catalog editing/icons                | `CatalogRouteStore`: asset lookup/staging, page creation/removal/order, item creation/membership/order/alias reconciliation; `IconFiles` read/save. `CatalogService` adds only the private catalog read needed by app composition.                                                                   |
| Competitions                         | `CompetitionService`: source clock, public activities, optional serialized snapshot, preview and apply with explicit actor/role/revisions/key/acknowledgement. Optional snapshot supports ordinary injected reads without cache internals.                                                           |
| Lifecycle history                    | `LifecycleReader`: list/detail only; no archive/restore/owner CLI methods. Existing `LifecycleError` translation is retained.                                                                                                                                                                        |
| Branding                             | Existing `BrandingStore` settings/asset/save plus `BrandingFiles` read/saveLogo and favicon read.                                                                                                                                                                                                    |
| Scheduling / RuneLite settings       | Existing structural `SchedulingStore` and `RuneLiteSettingsStore`, each exposing only its own domain reads/writes.                                                                                                                                                                                   |

## Acceptance and future changes

`transaction.integration.test.ts` verifies actual isolation/read-only modes,
domain/SQL rollback, concurrent receipt/credit races, and real PostgreSQL
waiters proving scheduling precedes later locks. It injects a lost response
after a real COMMIT and a second rollback failure, checks original-error
preservation/connection discard/no automatic retry, and recovers exactly one
manual receipt/credit/audit. Existing import lost-acknowledgement, catalog,
review, schedule, pool recovery and shutdown tests remain required.

`route-services.test.ts` uses minimal typed doubles through production auth,
CSRF, schema and error handling. It exercises 401/403 before writes, permitted
moderator catalog editing, owner-only history/final SKILL rules, 409/422 domain
failures, sanitized 503 reads and uncertain competition/catalog writes whose
exact retry keys recover a stored receipt. It does not claim those in-memory
failures prove SQL durability; PostgreSQL and production-image gates do that.

Run `node scripts/check-local.mjs` for complete local acceptance. New stores
must document their isolation, lock order, constraints, receipt protocol,
commit uncertainty and filesystem boundary before sharing transaction plumbing.
New routes must declare the domain methods they call and compile with ordinary
typed doubles while retaining their existing wire and authorization contracts.

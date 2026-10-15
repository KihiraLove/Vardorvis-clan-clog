# Architecture

The maintained architecture and operations/test inventory is
[current state](current-state.md). This page maps the code boundaries.

| Boundary       | Responsibility                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Web            | Public projections and staff UI; one client session owner, prepared authorized navigation, isolated explicit preview ledger. |
| API            | Validates/authenticates requests, enforces roles/admission and invokes narrow service contracts.                             |
| Stores         | Own explicit SQL locking, version checks, atomic audits/receipts and cache invalidation.                                     |
| Domain         | Canonical identities, world-mode credit rules, matching/validation and exact integer XP.                                     |
| Database tools | Checksummed migration ledger, restricted role bootstrap, catalog import and bounded owner maintenance.                       |
| Bot            | Acknowledges/adapts Discord interactions, calls API with service credentials and preserves receipt identity on retries.      |
| Container      | Nginx static/same-origin proxy, API and optional bot with ordered drain and independent gateway recovery.                    |
| Deployment     | Versioned digest-pinned infrastructure, coordinated backup and isolated restore.                                             |

PostgreSQL is authoritative; local process caches hold immutable revisioned
projections. File volumes retain icons/branding and private proof. Public
responses omit staff identity, proof and private settings. The bot never writes
SQL directly. Owner credentials are absent from the long-running API role.

See [store transactions and route capabilities](store-and-route-contracts.md),
[public projections](public-performance.md), [runtime availability](runtime-operations.md),
[database/release compatibility](release-recovery.md) and
[runtime packaging](runtime-packaging-and-auth-retirement.md).

The [project walkthrough](project-guide.md) and [foundation ADR](decisions/001-foundation.md)
are dated historical context. Their old topology, OAuth and pending-feature
statements are not the current architecture contract.

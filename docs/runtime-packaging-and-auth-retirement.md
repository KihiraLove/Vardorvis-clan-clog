# Runtime packaging and retired OAuth schema

Implements [#98](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/98) and
[#99](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/99), from REVIEW-02
B11 / REVIEW-03 R09–R10. See the [current inventory](current-state.md).

## Build and image boundary

`npm run build` compiles all workspace sources and tests for validation.
`npm run build:runtime` uses each Node workspace's `tsconfig.runtime.json` to
exclude test/spec files and fixture directories. Both modes clean their own
`dist` before compiling; switching modes cannot retain stale test output.
Runtime compilation emits declarations needed by downstream workspaces, but
`scripts/package-runtime.mjs` copies only JavaScript and package metadata into a
fresh staging directory. It rejects test trees, symlinks, missing entry points
and compiled imports of `node:test`; declarations and source maps are omitted.

Docker's checks target keeps test sources/fixtures and the normal build pipeline.
The production image copies only the staged runtime, production dependencies,
pinned catalog/icons, immutable migration SQL, built web assets, proxy/supervisor
and versioned release bundle. Owner CLIs, bot registration, maintenance and
catalog commands remain available. `prune-runtime-tests.mjs` removes only obvious
upstream dependency test/fixture artifacts; it preserves runtime data, metadata
and licenses, never follows workspace links, and refuses to remove a declared
package entry point. It validates every removal stays inside `node_modules`.

Before injecting any smoke helper, local acceptance pipes the read-only
`inspect-runtime.mjs` into the unmodified image with no network. It hashes all
first-party files against `runtime-manifest.json`, verifies migration bytes
against the release manifest, checks required entries/assets and scans for test
artifacts in workspace and dependency trees. It asserts `/app/scripts` is absent.
The generated `runtime-image.json` records counts/bytes and checks. The smoke job
injects only its required competitions helper into the disposable container;
that helper is absent from the production image. No test artifacts are deleted
from the validation target or developer checkout.

## Forward retirement

Reference/caller audit found no live OAuth-state callers. Password staff auth
already replaced OAuth. Migration `021_retire_oauth_states.sql` removes only the
unused short-lived handshake table; SQL 001–020 is unchanged. The corresponding
store methods/types, inert test state, runtime grants and special proxy callback
location are removed. Retired login/callback paths return ordinary private API
404 responses, without query reflection. Password login/session/logout,
credential-version invalidation, CSRF and origin checks remain in effect.

The migration deliberately uses `DROP TABLE oauth_states` without `CASCADE` or
an existence bypass. Unexpected dependent objects or schema drift stop the
transaction; operators must investigate them. It does not delete staff accounts,
sessions, submissions, saved notes, credits, settings or audits.

## Supported combinations

| Starting state                                                 | Candidate                | Expected result                                                                |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Fresh DB                                                       | Current 001–021 image    | Full schema, bootstrap and restricted grants; normal startup.                  |
| Valid checksummed 001–020 prefix                               | Current 001–021 image    | Forward upgrade; existing password sessions and all business tables preserved. |
| Exact 001–021 ledger                                           | Same compatible manifest | Idempotent startup; approved compatible application rollback can proceed.      |
| Exact 001–021 ledger                                           | Old 001–020 image        | Rejected as an unknown future migration before stopping current writers.       |
| Changed/missing/unknown ledger, or dependency on retired table | Current image            | Fail closed; no partial retirement or checksum rewriting.                      |

Take a coordinated pre-upgrade backup with matching old image/infrastructure,
database, both file volumes and encryption root. After applying 021, image-only
rollback to a pre-021 release is unsupported. If an older schema is essential,
restore that matching backup and approved image in a new isolated namespace,
verify it, reconcile writes after the backup and approve cutover using
[release recovery](release-recovery.md). Never delete ledger rows, edit old SQL,
run an ad hoc DOWN migration or recreate an empty OAuth table to bypass preflight.

Acceptance seeds the real 001–020 checksummed schema with an account/session,
claim/credit, saved note, catalog and an old OAuth token. It proves dependency
failure is atomic, upgrades/repeated migration preserve every business table,
the old manifest rejects 021, and current login/session/CSRF/logout work. Runtime
grant tests and production startup/smoke run against 021. The isolated recovery
job covers compatible manifests and genuine migration failure. These are local
controlled-image rehearsals; a real published prior-release restore and actual
host cutover remain explicit release gates in #104.

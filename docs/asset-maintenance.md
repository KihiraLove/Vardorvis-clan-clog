# Abandoned upload maintenance

Task [#80](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/80) implements
REVIEW-02 B08 / REVIEW-03 R03. This is an explicit one-shot operation; it does not
run inside upload requests or on a GitHub schedule.

## Retention and concurrency

Apply migration `016_asset_maintenance.sql` and reconcile the runtime role with
the normal bootstrap before using this command. Pre-existing migration files
are unchanged. The migration supplies a durable retirement journal and database
triggers covering catalog assets/items, logos/favicons and screenshot metadata.
The application role can read the journal but cannot alter it or run cleanup.

Cleanup retains every screenshot/logo metadata record, including historical and
unlinked metadata, both normal and hardcore branding, inactive catalog items,
unexpired/recent staged catalog assets, and UUID references in submission,
catalog and review audit/receipt JSON. It does not change or delete evidence,
receipts, asset metadata or audit rows. Only expired, unattached catalog uploads
and files without retained references can be collected. Conservatively retained
metadata/evidence has no automatic age-based expiry.

Files must be at least **24 hours old** by modification time, with a configurable
longer grace period. Only generated UUID PNG/WebP names and their `.tmp` names
are candidates. The scanner visits the icon root, its known `branding`
subdirectory, and the proof root explicitly. It never recurses into other
directories, follows symlinks, deletes hardlinks,
or touches unknown names. In particular, `.clan-api-key.secret` is always
preserved. Icons and private proofs must use distinct dedicated directories.

Each candidate is checked while holding an exclusive transaction advisory lock.
The write triggers hold its shared counterpart through metadata/reference
commit. A committed upload is retained. A long-paused upload whose old filename
is retired first is rejected on its eventual database write and must be uploaded
again; it cannot commit a dangling reference. Asset writes require PostgreSQL's
normal READ COMMITTED isolation so an older snapshot cannot miss a retirement.
Ordinary new uploads remain within the grace period.

The journal commits **before** unlink. A crash or lost acknowledgement therefore
leaves a safe pending retirement; a subsequent invocation retries it, including
the case where unlink succeeded before its completion record was saved. Retired
UUIDs are never reusable. File identity, size and timestamps are checked again
before unlink; an unexpected replacement is retained and reported as an error.
Do not manually replace files under generated asset names during maintenance.
Do not remove journal rows to reclaim space or reuse an old UUID.

## Operator commands

Use the reviewed application image through the owner-credentialed `migrate`
service, which mounts the same icon/proof volumes. No live application shutdown
is required. Never run this command against a different database from the one
owning these volumes. Keep backup/deployment and filesystem restoration separate
from maintenance, using the operator deployment lock as shown:

```bash
cd /srv/vardorvis-clan-clog
flock -n .deploy.lock docker compose run --rm --no-deps migrate \
  node packages/database/dist/asset-maintenance.js --dry-run

# Review the report first, then run a bounded apply.
flock -n .deploy.lock docker compose run --rm --no-deps migrate \
  node packages/database/dist/asset-maintenance.js --apply \
  --grace-hours=24 --max-files=100 --max-entries=1000
```

Dry-run is the default and changes no files or journal rows. JSON reports include
the cutoff, checked/eligible/referenced/fresh/unsafe/unknown/busy/error counts,
retired/removed counts, bytes reclaimed and directory scan offsets. A shared
worker lock rejects simultaneous maintenance commands. Busy asset transactions
are skipped; retry later. Missing/disabled database barriers abort before any
unlink. Database/mount failures fail closed; the CLI omits raw database errors
and credentials. Filesystem failures and unexpected post-retirement references
produce a nonzero exit and leave a pending journal entry for investigation.

The default run inspects at most 100 candidate files and 1,000 directory entries
per directory. Limits may be raised to 500 candidates and 10,000 entries. The
30-second time budget is checked between operations; an in-flight database
statement has a 10-second timeout. Offset traversal is also time-bounded and
capped at 1,000,000 skipped entries. Memory use does not grow with directory size.

For a large directory, continue using the report's `stores.icons.nextOffset`,
`stores.branding.nextOffset` and `stores.proofs.nextOffset` as
`--icons-offset=N --branding-offset=N --proofs-offset=N`. Zero means the
directory reached its end (or was not visited because another bound was reached).
Directory ordering can change as files are added/deleted: **repeat complete
cycles from offset zero** to revisit entries shifted across a scan boundary.
Offsets are traversal hints, not deletion permissions. Pending retirements are
retried first, independent of scan offsets. For directories beyond these bounds,
plan an explicit storage-layout migration rather than disabling safety limits.

Only files are reclaimed. Expired staging metadata, completed retirement records
and immutable history stay in PostgreSQL. Inspect large counts and plan a
separate reviewed database retention policy if needed. A reference retained only
in immutable history deliberately keeps its file available indefinitely.

Run `npm run test:all` locally to include migration, runtime-role, interruption,
concurrent-upload and production-volume smoke coverage. See
[local testing](local-testing.md) and [deployment](deployment.md).

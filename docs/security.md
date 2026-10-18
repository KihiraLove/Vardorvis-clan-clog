# Security and runtime behavior

Staff use individual password accounts with salted scrypt hashes, first-login
password changes, server sessions and role checks. HTTPS cookies, exact Origin
and CSRF validation protect writes. Browser bundles never receive backend secrets.
Only the administrator changes site settings, shared keys and staff accounts.
Discord settings also require the administrator and CSRF validation. The Discord
token and automatically generated internal API token are encrypted with AES-GCM
using the private volume's encryption root and a separate purpose identifier.
Admin responses expose only whether a token exists; audit rows contain settings
and a token-change flag, never credentials. Configuration reads fail closed if
the encryption root is missing or incorrect. Changing the Discord token also
rotates the internal token. Saved settings are read again before intake requests.

The API's `clog_runtime` role has explicit table/sequence permissions, no DDL or
ownership, and no ability to rewrite receipts or audit history. Bootstrap removes
unexpected grants. Owner credentials are reserved for setup and maintenance. Generated DB/session credentials live in protected subdirectories of `/data/system`. Application workers run as UID 1000 and cannot traverse the root-owned database-owner directory. The root supervisor handles setup and maintenance; the application uses `clog_runtime`. Secret files are read inside Node and persist across updates. A root-only local control socket coordinates maintenance.

Fresh startup prints a random temporary administrator password near the beginning of container logs, before database/catalog setup. The private pending credential survives interrupted setup. The first login requires a replacement password; its successful commit removes pending state. Later startup never resets an administrator or prints their permanent password. Keep container logs private while the initial password remains active.
Review revisions and database constraints protect credits under concurrent writes.

Nginx enforces same-origin scripts/styles/API and denies framing. Local image
previews allow narrowly scoped blob/data URLs; generated asset paths are validated.
Proof links are allowlisted HTTPS origins with no referrer/opener access. PNG
screenshots and full RuneLite chat messages are private staff evidence.

Upload limits are 10 MiB for proofs/logos and 2 MiB for catalog icons; the server
checks decoded format and dimensions. WOM reads have an 8 MiB ceiling and a
6.5-second operation deadline. Login hashing, previews and Discord requests have
bounded admission and concurrency. Public requests use stored DB projections,
not unbounded upstream calls. Keep dependencies current and retain audit evidence.

`/healthz` reports process liveness. `/readyz` requires the API accepting work
and a DB probe. Discord status is independent. A failed bot restarts with backoff;
API/proxy failure stops the application container. Compose restarts it.
Shutdown drains bot, API and proxy before PostgreSQL stops, within the 90-second grace period. A lost
COMMIT/response may still have saved data; retry the same identity to reconcile.

Operational logs/counters use bounded sanitized error classes and correlation
IDs. Keep proof, keys, cookies and raw DB errors out of public logs. Run acceptance
against a disposable stack, then verify HTTPS/proxy trust on your own host.
See [testing](local-testing.md) and [recovery](release-recovery.md).

# Security and runtime behavior

Staff use individual password accounts with salted scrypt hashes, first-login
password changes, server sessions and role checks. HTTPS cookies, exact Origin
and CSRF validation protect writes. Browser bundles never receive backend secrets.
Only the administrator changes site settings, shared keys and staff accounts.

The API's `clog_runtime` role has explicit table/sequence permissions, no DDL or
ownership, and no ability to rewrite receipts or audit history. Bootstrap removes
unexpected grants. Owner credentials are reserved for setup and maintenance. Generated DB/session
credentials live in separate private volumes, mounted read-only only into their
consumers. Secret-file inputs are read inside Node, never copied to environment
variables. Default application containers have no owner DB credential. First-admin
provisioning is an explicit local command; temporary credentials are never printed
by normal startup. Machine secrets persist across updates.
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
Shutdown drains bot, API and proxy within the 70-second grace period. A lost
COMMIT/response may still have saved data; retry the same identity to reconcile.

Operational logs/counters use bounded sanitized error classes and correlation
IDs. Keep proof, keys, cookies and raw DB errors out of public logs. Run acceptance
against a disposable stack, then verify HTTPS/proxy trust on your own host.
See [testing](local-testing.md) and [recovery](release-recovery.md).

# Versioned releases and isolated recovery

Implements [#92](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/92)
(REVIEW-02 B10/B05) and [#93](https://github.com/KihiraLove/Vardorvis-clan-clog/issues/93)
(REVIEW-02 B03/B10). These commands operate on a dedicated PostgreSQL 17 database.

## Release identity and infrastructure

Each application image contains `/opt/clog-release`: exact Compose files,
deployment/backup/restore helpers, proxy/supervisor configuration, this guide,
all checksummed migrations and a manifest. Image builds record the full source
revision and the successful release acceptance workflow URL. Development images
record local acceptance instead and are never published automatically.

Install the reviewed `infra/deploy.sh` launcher as
`/srv/vardorvis-clan-clog/deploy.sh` with mode 755. Configure the protected
`home-production` environment variable `CLOG_DEPLOY_LAUNCHER_SHA256` with its
`sha256sum` digest. A launcher update requires installing its reviewed bytes and
updating that variable. The deployment workflow verifies it before invocation;
it still verifies successful published-release acceptance before using the host.
The Linux host needs Bash, Docker/Compose, jq, coreutils, tar and flock. No checkout
or host Node installation is needed. Keep the deployment directory and `.env`
restricted to the deployment account (`chmod 700` / `chmod 600`).

The launcher pulls the approved SHA tag, verifies the image revision, resolves its
registry digest, extracts and verifies the image's infrastructure bundle, and
executes that version's helper under the deployment lock. The runtime and migrator
use that digest. Subsequent deployments retain the recorded PostgreSQL digest;
database upgrades require a separate reviewed recovery rehearsal. The first
installation resolves PostgreSQL 17's current image to a digest before startup.

Successful deployment publishes `.current-release.json` with application digest
and platform image ID provenance, PostgreSQL digest/version, full applied migration
ledger, infrastructure location/manifest checksum, installed launcher checksum,
and acceptance evidence. `releases/` retains earlier verified bundles;
`.previous-release.json` retains the prior successful identity. Failed attempts
retain private `evidence/deploy-*` directories and never replace successful state.
Secrets and rendered Compose environments are excluded from release evidence.
The atomic `.current-release.json` is authoritative for both deployment and backup;
`.current-infrastructure` and `.current-release` are convenience pointers. A crash
between pointer writes cannot select another bundle for a completed backup.

The default production namespace remains `vardorvis-clog`, preserving volume
identity. Compose comes from the bundle, with the existing Traefik overlay and
external `web` network. `CLOG_USE_TRAEFIK=false` explicitly selects the loopback
deployment. Arbitrary inherited Compose files/profiles are discarded.
Deployment stops the old writer before bootstrap, rotates runtime credentials
through the existing owner job, and recreates the API only after exact schema
validation. Normal operator deployment invokes the installed launcher with the
full approved release SHA; GitHub deployment remains manual and protected.

An existing unversioned running stack is not automatically adopted: first preserve
its exact Compose/helper bytes, image digests, secrets and a complete coordinated
legacy backup; rehearse its recovery and stop its writer before the first versioned
deployment. Legacy backups remain valid for their documented manual recovery,
but cannot claim the versioned automated restore contract below.

## Compatibility and recovery decisions

The existing migration policy validates the complete checksummed ledger before
pending DDL. A verified prefix can move forward transactionally. Image rollback
requires an identical applied manifest and compatible application/catalog
contracts. A missing/future/changed migration is rejected by preflight before
writers stop. There is no automatic downgrade, unknown-ledger override or
automatic rollback after a failed migration/health check.

For an unavailable image, leave the current service running and recover registry
access or select an approved available release. For migration failure, inspect
the private attempt log and ledger; a transactional failure does not justify
editing migration checksums. Fix its cause and retry. If startup failed after
successful migration, keep writers stopped until a compatible release or verified
matching restore is selected. A process crash uses the documented
[availability/shutdown policy](runtime-operations.md); durable receipts still
need reconciliation after an uncertain commit.

For an approved compatible rollback, invoke the same installed launcher with the
previous approved SHA after verifying its manifest and catalog contract. It takes
a fresh coordinated backup and runs preflight/bootstrap normally. Restoring an
older schema instead requires its matching database, both filesystem archives,
encryption root and pinned image/infrastructure; image rollback alone cannot
remove applied schema changes. Backup-time data is the recovery point: later
writes are not implicitly recovered and must be reconciled before cutover.

Runtime password rotation updates the restricted host `.env`, followed by the
normal versioned deployment. Owner/bootstrap reconciles the role transactionally;
stopping/recreating the API prevents reuse of old sessions. Rehearsal verifies old
credentials cannot open new connections, new credentials retain restricted grants,
and state survives. Owner-password rotation additionally requires PostgreSQL
`ALTER ROLE`; changing the initialization environment does not rotate an existing
volume. Keep credential changes out of shell tracing, source and test evidence.

## Complete versioned backup and restore

Use the verified current bundle rather than mutable checkout files:

```bash
CLOG_DEPLOY_ROOT=/srv/vardorvis-clan-clog bash /srv/vardorvis-clan-clog/releases/RELEASE/infra/backup-current.sh /safe/new/backup
```

In addition to the existing three captures and atomic `COMPLETE`, a versioned
backup includes `release.json`, an exact `schema.json`, the complete
`infrastructure/` bundle and verified metadata checksums. Capture binds the actual
stopped app image and running database image to their recorded identity. A mismatch,
schema error or failed writer restart leaves no `COMPLETE` marker. Copy the complete
directory to encrypted off-host storage, with the original secret configuration
stored separately. The database dump includes accounts, histories, receipts and
private information; the screenshot archive includes the clan-key encryption root.

Recovery always starts in a **new isolated namespace** with empty volumes:

```bash
mkdir -m 700 /safe/recovery-clone
# Supply a new restricted .env with independent clone credentials/session secret,
# AUTH_ENABLED=true and an internal PUBLIC_ORIGIN. Never copy live Discord tokens.
bash /safe/backup/infrastructure/infra/restore.sh /safe/backup clog-restore-rehearsal /safe/recovery-clone
```

Ensure the recorded application and PostgreSQL digests are available locally first
(`docker pull` their digest references). Restore rejects incomplete/corrupt backups,
unsafe archive entries, missing/wrong images or platform identity, and an existing
target namespace before changing resources. It verifies checksums, restores the
custom-format dump without global-role grants, validates the exact ledger, restores
both image volumes with node ownership, recreates restricted role grants and starts
the image. It never initializes the app before restoring its encryption root.
Both the hidden `.clan-api-key.secret` and encrypted key rows must match; startup
fails with a wrong root. Current restore support is the recorded PostgreSQL major
and application platform, not a cross-version/architecture migration.

The clone has no published ports, no Traefik network and no Discord login. Its
original source stack stays untouched. Inspect `evidence/restore-status` and logs
on failure; resources remain for diagnosis. After acceptance, remove only the
clone's Compose resources using its recorded project/env/bundle and verify the
project label before `down --volumes`. Never run a global Docker prune.
Production cutover is a separate approved operation: stop live writers, take a
fresh backup, reconcile writes after the recovery point, configure TLS/proxy and
fresh secrets, then change routing only after the clone passes acceptance.

## Automated evidence and remaining host acceptance

`npm run test:all` includes the same recovery job used by manual/release CI.
It starts a disposable versioned deployment, seeds representative accounts,
credits, audits, XP/import histories, schedules, manual catalog edits, logos/icons
and private screenshot evidence, then captures a real coordinated backup. It
restores to fresh volumes and compares complete database/table and filesystem
fingerprints, tests login, image references, private proof access and clan-key
decryption. A missing/wrong encryption root is rejected without replacing the key.
It also rehearses unavailable image, incompatible/migration failure, credential
rotation, API process crash and approved compatible rollback. Corrupt/incomplete
backup and target reuse failures are checked, with label-scoped cleanup and
retained failure evidence. No external gateway or production data is used.

Evidence records the actual image IDs/digests, bundled infrastructure/migration
checksums, PostgreSQL version, semantic inventory and scenario results. Successful
host-specific TLS, actual guild/gateway, off-host backup transport, filesystem
capacity, host restart and operator cutover acceptance remain release checks in
#104 and the original #11/#13. A local rehearsal does not establish those outcomes.

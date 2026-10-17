# Backups and recovery

A usable backup includes the database, catalog/branding files, private proof
files (including `.clan-api-key.secret`), managed machine-secret volumes, private configuration and matching
image/schema identity. Copy the complete backup to encrypted off-host storage.
It contains account hashes, private evidence and clan credentials.

## Back up

For a versioned installation, use the verified current bundle:

```bash
bash /srv/clan-collection-log/releases/RELEASE/infra/backup-current.sh /safe/new/backup
```

For an unversioned local stack, select the same Compose files as startup and
run `bash infra/backup.sh /safe/new/backup`. The backup includes a private configuration copy and a managed-secrets archive.
Keep its exact Compose files and protect external-provider credentials separately. Versioned automated restore needs the recorded
release bundle; a local dump alone cannot claim that contract.

The command takes a deployment lock, stops writers, captures the DB and both
asset volumes, verifies checksums, and restarts only writers it stopped. An atomic
`COMPLETE` marker is written only after every check and required restart passes.
Without that marker, investigate the backup log rather than treating it as usable.

## Restore into an isolated clone

Ensure the backup's application and PostgreSQL digests are locally available.
Create a new directory with a private `.env`, no copied machine-secret seeds or external secret paths,
an internal origin and no real Discord token. Then:

```bash
mkdir -m 700 /safe/recovery-clone
# Add /safe/recovery-clone/.env before continuing.
bash /safe/backup/infrastructure/infra/restore.sh /safe/backup clog-restore-rehearsal /safe/recovery-clone
```

Restore initializes independent machine credentials for the clone. The original
managed-secrets archive is retained for controlled recovery of the original
installation; it is not applied to an isolated clone.

Restore rejects incomplete/corrupt backups, unsafe archives, wrong images and
existing target namespaces. It restores DB and files before app startup,
reconciles runtime permissions and checks restored state. The clone has no
public ports, external proxy or Discord login. Inspect `evidence/restore-status`
on failure; the source remains untouched. Test logins, images, private proof,
credits and clan-key decryption before planning any cutover.

## Updates and rollback

The first release uses one checksummed `001_baseline.sql`. Old development
databases must be recreated. Later release migrations will be additive.
Changed, missing or unknown migration history blocks startup and deployment.

An image-only rollback requires the exact same applied schema manifest and
compatible catalog contracts. Otherwise restore the matching coordinated backup;
there is no automatic schema downgrade. Recovery loses changes made after the
backup unless you reconcile them separately. Rehearse before changing routing.

For managed credentials, select the same Compose files as startup and run
`bash infra/rotate-secrets.sh app`, `session` or `postgres` from the installation
directory (use the verified current bundle for versioned installs). This takes a
private backup, stops writers, updates the relevant file and PostgreSQL role when
needed, then verifies application readiness. Session rotation signs everyone out.
If interrupted, keep writers stopped, repair access and repeat with `--resume`;
pending credentials are retained privately. Do not edit initialization seeds to
rotate existing passwords.
Keep earlier verified images and bundles with your backups.

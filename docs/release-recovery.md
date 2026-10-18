# Backups and recovery

Backups contain account hashes, private evidence and encrypted integration keys.
Keep the complete backup in encrypted off-host storage, plus a copy of your
Compose configuration and the recorded image. A raw copy of a running database
volume is not a consistent backup.

## Back up one service

From your Compose directory, using the same Compose files as startup:

```bash
bash /path/to/infra/backup.sh /safe/new-backup clan-clog
```

The optional final argument selects your service; its default is `clan-clog`.
`CLOG_SERVICE` is an alternative. Helpers work alongside unrelated Compose services.
They never stop the whole project. Keep `infra/` from the matching reviewed release.

The command pauses this installation's API/proxy/bot, leaves PostgreSQL running,
creates a logical dump, captures uploads and generated secrets, then resumes the
website and checks readiness. `COMPLETE` is published only after capture, checksums
and readiness pass. A missing marker means the backup is unusable. Check a paused
installation with `docker compose exec --user 0 clan-clog clog status`; after
repair, `clog resume` explicitly resumes it.

## Restore to a fresh service

Make the backup's recorded image available locally. In a Compose file, define a
new service with a **new named `/data` volume**, `BOT_SETTINGS_MODE: disabled`,
an internal origin, no published ports and no external proxy network. This can
be in your existing project; do not start the new service first.

```bash
bash /path/to/infra/restore.sh /safe/new-backup recovery-clog
```

Restore checks integrity and image identity before creating resources. It refuses
existing target containers or volumes, restores the DB and uploaded files, checks
the migration ledger and grants, then starts the service. It preserves accounts,
passwords, reviews and the upload encryption root. A clone gets independent DB
and session credentials. The source secrets archive remains in the backup for
controlled original-installation recovery. Save your Compose configuration
separately; restore does not apply the captured settings to other services.

On failure, target resources remain for inspection; no automatic overwrite or
retry occurs. Inspect logs and `clog status`, then use another fresh service/volume
for a new attempt. Before cutover, test logins, credits, images, private proof and
integration-key decryption. Keep Discord disabled during rehearsals.

## Rotation and rollback

```bash
bash /path/to/infra/rotate-secrets.sh app clan-clog
bash /path/to/infra/rotate-secrets.sh session clan-clog
bash /path/to/infra/rotate-secrets.sh postgres clan-clog
```

Each command backs up first, pauses writers, changes the selected managed
credential and verifies readiness. Session rotation signs everyone out. If
interrupted, repair access and repeat with `--resume` before the service name.
Do not rotate credentials by editing initialization seeds.

An image rollback requires the same applied schema and compatible catalog.
Missing, changed or unknown migration history blocks startup. Otherwise restore
a matching backup; schema downgrade is not automatic. Recovery loses changes
after the snapshot unless reconciled separately. Earlier development snapshots
are unsupported; this release begins with `001_baseline.sql`.

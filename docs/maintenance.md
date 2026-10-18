# Maintenance

Use the matching Compose configuration and select your installation service. The examples use `clan-clog`; owner commands run locally through the root-only `clog` maintenance tool. Keep a coordinated [backup](release-recovery.md) before maintenance.
Do not run against a different database from the mounted asset volumes.

## Abandoned uploads

```bash
docker compose exec --user 0 clan-clog clog owner \
  node packages/database/dist/asset-maintenance.js --dry-run
# Inspect the report, then explicitly apply a bounded batch:
docker compose exec --user 0 clan-clog clog owner \
  node packages/database/dist/asset-maintenance.js --apply --grace-hours=24 --max-files=100 --max-entries=1000
```

Cleanup preserves referenced assets, evidence metadata, historical audit/receipt
references and the clan-key encryption root. Candidates must be generated names
at least 24 hours old. Unknown names, symlinks and hardlinks are skipped. A durable
journal and transaction barriers protect concurrent uploads; interrupted batches
can be retried. Do not reuse retired UUIDs or edit files under generated names.
Continue large scans using the next offsets in the report and repeat full cycles
from zero. Missing DB barriers or unexpected file replacement fails closed.

## Expired previews

```bash
docker compose exec --user 0 clan-clog clog owner node packages/database/dist/preview-maintenance.js --dry-run
```

Review the report before adding `--apply`. Only sufficiently expired previews
are removed; durable receipts and import history remain replayable.

## Ended schedules and competitions

```bash
docker compose exec --user 0 clan-clog clog owner node packages/database/dist/lifecycle.js --resource=competitions --view=current --limit=20
docker compose exec --user 0 clan-clog clog owner node packages/database/dist/lifecycle.js --resource=competitions --action=detail --id=123
docker compose exec --user 0 clan-clog clog owner node packages/database/dist/lifecycle.js --resource=competitions --action=archive --id=123 --actor="Operator" --reason="Ended event"
```

Mutation is dry-run by default; inspect it, then repeat with `--apply`. Use
`--resource=schedules` with a schedule UUID, or `--action=restore` to restore
an archived record. Only ended records can be archived. Limits are 2,000 current
schedules, 2,000 current competitions and 2,000 all-time XP contributions.
Archival frees a current metadata slot while preserving results, receipts,
audits and published XP. It does not free an all-time XP slot. List pages use
opaque cursors; do not edit them or combine different snapshots.

#!/usr/bin/env bash
# Coordinate a database + immutable-icon backup while application writers are stopped.
set -euo pipefail
umask 077
# Deploy already holds this lock; standalone backups acquire it themselves.
if [[ "${BACKUP_DEPLOY_LOCK_HELD:-}" != 1 ]]; then
  exec 9>.deploy.lock
  flock -n 9 || { echo 'Another backup or deployment is in progress'; exit 1; }
fi
backup_dir="${1:?Supply a new backup directory}"
[[ ! -e "$backup_dir" ]] || { echo 'Backup directory already exists'; exit 1; }
mkdir -p "$backup_dir"
mapfile -t writers < <(docker compose ps --status running --services | grep -E '^app || true)
resume() { if ((${#writers[@]})); then docker compose start "${writers[@]}"; fi; }
trap resume EXIT
if ((${#writers[@]})); then docker compose stop "${writers[@]}"; fi
docker compose exec -T db pg_dump -U clog -d clog -Fc > "$backup_dir/database.dump.tmp"
docker compose run --rm --no-deps -T --user 0 --entrypoint tar app -C /data/catalog-icons -czf - . > "$backup_dir/icons.tar.gz.tmp"
mv "$backup_dir/database.dump.tmp" "$backup_dir/database.dump"
mv "$backup_dir/icons.tar.gz.tmp" "$backup_dir/icons.tar.gz"
(cd "$backup_dir" && sha256sum database.dump icons.tar.gz > SHA256SUMS)
if [[ -f .current-release ]]; then cp .current-release "$backup_dir/release.txt"; fi
printf 'complete\n' > "$backup_dir/COMPLETE"
echo "Completed coordinated backup: $backup_dir"
 || true)
resume() { if ((${#writers[@]})); then docker compose start "${writers[@]}"; fi; }
trap resume EXIT
if ((${#writers[@]})); then docker compose stop "${writers[@]}"; fi
docker compose exec -T db pg_dump -U clog -d clog -Fc > "$backup_dir/database.dump.tmp"
docker compose run --rm --no-deps -T --user 0 --entrypoint tar api -C /data/catalog-icons -czf - . > "$backup_dir/icons.tar.gz.tmp"
mv "$backup_dir/database.dump.tmp" "$backup_dir/database.dump"
mv "$backup_dir/icons.tar.gz.tmp" "$backup_dir/icons.tar.gz"
(cd "$backup_dir" && sha256sum database.dump icons.tar.gz > SHA256SUMS)
if [[ -f .current-release ]]; then cp .current-release "$backup_dir/release.txt"; fi
printf 'complete\n' > "$backup_dir/COMPLETE"
echo "Completed coordinated backup: $backup_dir"

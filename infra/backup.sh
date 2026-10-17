#!/usr/bin/env bash
# Coordinate one consistent database and image-volume backup while writers are stopped.
set -euo pipefail
umask 077

# Deploy already holds this lock; standalone backups acquire it themselves.
if [[ "${BACKUP_DEPLOY_LOCK_HELD:-}" != 1 ]]; then
  exec 9>.deploy.lock
  flock -n 9 || { echo 'Another backup or deployment is in progress' >&2; exit 1; }
fi

backup_dir="${1:?Supply a new backup directory}"
[[ ! -e "$backup_dir" ]] || { echo 'Backup directory already exists' >&2; exit 1; }
mkdir -p "$backup_dir"

# A successful (not merely empty) inventory is mandatory. The only persistent
# application writer is app; migrate is a separate schema writer and must be idle.
running_services=()
inspect_running() {
  local output service known
  if ! output="$(docker compose ps --status running --services)"; then
    echo 'Backup writer inventory failed: docker compose ps did not succeed' >&2
    return 1
  fi
  running_services=()
  while IFS= read -r service; do
    case "$service" in
      app|db|migrate) ;;
      *) echo "Backup writer inventory uncertain: unexpected running service: $service" >&2; return 1 ;;
    esac
    for known in "${running_services[@]}"; do
      if [[ "$known" == "$service" ]]; then
        echo "Backup writer inventory uncertain: duplicate running service: $service" >&2
        return 1
      fi
    done
    running_services+=("$service")
  done <<< "$output"
  if ! service_is_running db; then
    echo 'Backup writer inventory uncertain: database service is not running' >&2
    return 1
  fi
  if service_is_running migrate; then
    echo 'Backup writer inventory uncertain: migration service is running' >&2
    return 1
  fi
}
service_is_running() {
  local candidate
  for candidate in "${running_services[@]}"; do
    [[ "$candidate" != "$1" ]] || return 0
  done
  return 1
}

# Record original writers before issuing a potentially partial stop.
# The EXIT handler restores them even if stopping or capture fails.
original_writers=()
finish() {
  local status=$? writer restart_ok=1
  trap - EXIT INT TERM
  if (("${#original_writers[@]}")); then
    if ! docker compose start "${original_writers[@]}"; then
      echo 'BACKUP RESTART FAILED: docker compose start failed; operator intervention required' >&2
      restart_ok=0
    elif ! inspect_running; then
      echo 'BACKUP RESTART FAILED: unable to verify running writers' >&2
      restart_ok=0
    else
      for writer in "${original_writers[@]}"; do
        if ! service_is_running "$writer"; then
          echo "BACKUP RESTART FAILED: $writer is not running" >&2
          restart_ok=0
        fi
      done
    fi
  fi
  if (( ! restart_ok )); then status=1; fi
  if (( status == 0 )); then
    if ! { printf 'complete\n' > "$backup_dir/COMPLETE.tmp" && mv "$backup_dir/COMPLETE.tmp" "$backup_dir/COMPLETE"; }; then
      echo 'Backup completion marker could not be published' >&2
      status=1
    else
      echo "Completed coordinated backup: $backup_dir"
    fi
  fi
  if (( status != 0 )); then
    rm -f "$backup_dir/COMPLETE.tmp"
    echo "Backup incomplete (no COMPLETE marker): $backup_dir" >&2
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

inspect_running
if service_is_running app; then original_writers+=(app); fi
if (("${#original_writers[@]}")); then
  docker compose stop "${original_writers[@]}"
fi
inspect_running
if service_is_running app; then
  echo 'Backup quiescence failed: application is still running' >&2
  exit 1
fi

# Create archives with temporary names; never publish partial outputs as complete.
docker compose exec -T db pg_dump -U clog -d clog -Fc > "$backup_dir/database.dump.tmp"
docker compose run --rm --no-deps -T --user 0 --entrypoint tar app -C /data/catalog-icons -czf - . > "$backup_dir/icons.tar.gz.tmp"
# The screenshot volume also contains the hidden .clan-api-key.secret
# encryption root; restoring PNGs without this root is insufficient.
# Older images may have created this volume as root; preserve the ownership fix.
docker compose run --rm --no-deps -T --user 0 --entrypoint sh app -c 'chown node:node /data/submission-images && tar -C /data/submission-images -czf - .' > "$backup_dir/screenshots.tar.gz.tmp"
docker compose run --rm --no-deps -T init
docker compose run --rm --no-deps -T --entrypoint tar init -C /run/clog-secrets -czf - ./postgres ./app ./session > "$backup_dir/secrets.tar.gz.tmp"
if [[ -f .env ]]; then cp .env "$backup_dir/configuration.env.tmp"; else : > "$backup_dir/configuration.env.tmp"; fi

# Re-inventory after capture to detect writers reappearing during the snapshot.
inspect_running
if service_is_running app; then
  echo 'Backup quiescence failed: application restarted during capture' >&2
  exit 1
fi
[[ -s "$backup_dir/database.dump.tmp" && -s "$backup_dir/icons.tar.gz.tmp" && -s "$backup_dir/screenshots.tar.gz.tmp" ]] || { echo 'Backup contains an empty capture' >&2; exit 1; }
tar -tzf "$backup_dir/icons.tar.gz.tmp" > /dev/null
tar -tzf "$backup_dir/screenshots.tar.gz.tmp" > /dev/null
mv "$backup_dir/database.dump.tmp" "$backup_dir/database.dump"
mv "$backup_dir/icons.tar.gz.tmp" "$backup_dir/icons.tar.gz"
mv "$backup_dir/screenshots.tar.gz.tmp" "$backup_dir/screenshots.tar.gz"
tar -tzf "$backup_dir/secrets.tar.gz.tmp" > /dev/null
mv "$backup_dir/secrets.tar.gz.tmp" "$backup_dir/secrets.tar.gz"
mv "$backup_dir/configuration.env.tmp" "$backup_dir/configuration.env"
(cd "$backup_dir" && sha256sum database.dump icons.tar.gz screenshots.tar.gz secrets.tar.gz configuration.env > SHA256SUMS.tmp && sha256sum --check SHA256SUMS.tmp > /dev/null && mv SHA256SUMS.tmp SHA256SUMS)
if [[ -n "${CLOG_RELEASE_DIR:-}" ]]; then
  # A versioned backup binds actual containers, schema and installed helper bytes.
  [[ -f .current-release.json && ! -L "$CLOG_RELEASE_DIR" ]] || exit 1
  (cd "$CLOG_RELEASE_DIR" && sha256sum --check SHA256SUMS >/dev/null)
  [[ "$(jq -er .bundleChecksum .current-release.json)" == "$(sha256sum "$CLOG_RELEASE_DIR/manifest.json" | cut -d' ' -f1)" ]] || { echo 'Backup infrastructure/state mismatch' >&2; exit 1; }
  app_id="$(docker compose ps --all -q app)"
  db_id="$(docker compose ps -q db)"
  actual_image="$(docker inspect --format '{{.Image}}' "$app_id")"
  expected_image="$(docker image inspect --format '{{.Id}}' "$(jq -er .image .current-release.json)")"
  [[ "$actual_image" == "$expected_image" ]] || { echo 'Backup image/state mismatch' >&2; exit 1; }
  source "$CLOG_RELEASE_DIR/infra/release-compose.sh"
  db_image="$(resolved_image "$(docker inspect --format '{{.Image}}' "$db_id")")"
  docker compose run --rm --no-deps -T migrate node packages/database/dist/release-state.js --exact > "$backup_dir/schema.json"
  cp -a "$CLOG_RELEASE_DIR" "$backup_dir/infrastructure"
  jq --arg imageId "$actual_image" --arg dbImage "$db_image" --slurpfile schema "$backup_dir/schema.json" '. + {imageId:$imageId,dbImage:$dbImage,schema:$schema[0]}' .current-release.json > "$backup_dir/release.json"
  (cd "$backup_dir" && sha256sum schema.json release.json > META-SHA256SUMS && sha256sum --check META-SHA256SUMS >/dev/null)
fi
if [[ -f .current-release ]]; then cp .current-release "$backup_dir/release.txt"; fi
# COMPLETE is written by finish *after* restart succeeds.

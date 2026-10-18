#!/usr/bin/env bash
# Restore to a selected service with a new, empty named data volume.
set -euo pipefail
umask 077
# shellcheck source=infra/release-compose.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-compose.sh"
backup="$(realpath "${1:?Usage: restore.sh BACKUP [SERVICE]}")"
verify_backup "$backup"
select_service "${2:-}"
lock_service
[[ -z "$(docker compose ps --all -q "$CLOG_SERVICE")" ]] || { echo 'Restore target already has a container; no data changed' >&2; exit 1; }
configuration="$(docker compose config --format json)"
jq -e --arg service "$CLOG_SERVICE" '
  . as $config | .services[$service] as $target |
  $target.environment.BOT_SETTINGS_MODE == "disabled" and
  (($target.ports // []) | length == 0) and
  ($target.labels."traefik.enable" // "false" | tostring) != "true" and
  ([$target.networks | keys[] | select($config.networks[.].external == true)] | length == 0)
' <<< "$configuration" >/dev/null || { echo 'Restore requires Discord disabled, no published ports and no external proxy network/route' >&2; exit 1; }
source_name="$(jq -er --arg service "$CLOG_SERVICE" '.services[$service].volumes | if length==1 and .[0].target=="/data" and .[0].type=="volume" then .[0].source else error("Restore requires exactly one named /data volume and no other mounts") end' <<< "$configuration")"
volume="$(jq -er --arg source "$source_name" '.volumes[$source] | select(.external != true) | .name' <<< "$configuration")"
if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Restore target volume already exists; no data changed' >&2; exit 1; fi
image="$(jq -er .image "$backup/release.json")"
write_image_override "$image"
override="$(mktemp "$CLOG_STATE_DIR/restore.XXXXXX.yaml")"
jq -n --arg service "$CLOG_SERVICE" '{services:{($service):{environment:{CLOG_START_MODE:"restore"}}}}' > "$override"
normal_files="$COMPOSE_FILE"
finish() { local status=$?; rm -f "$override"; if ((status)); then echo 'Restore failed; target resources retained for inspection. Other services are unchanged.' >&2; fi; exit "$status"; }
trap finish EXIT
COMPOSE_FILE="$normal_files:$override" docker compose up -d --no-deps "$CLOG_SERVICE"
id="$(service_container)"
ready=false
for _attempt in $(seq 1 120); do
  if docker exec --user 0 "$id" clog status 2>/dev/null | jq -e '.phase=="restore" and .database' >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Restore initialization failed; inspect container logs' >&2; exit 1; }
tar -C "$backup" -czf - . | docker exec -i --user 0 "$id" clog restore
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 "$CLOG_SERVICE"
echo "Restored $CLOG_SERVICE. The recorded image override is $CLOG_STATE_DIR/image.yaml."

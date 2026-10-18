#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=infra/release-compose.sh
source "${CLOG_RELEASE_DIR:?}/infra/release-compose.sh"
: "${CLOG_SERVICE:?}" "${CLOG_STATE_DIR:?}" "${RELEASE_IMAGE:?}"
attempt="$CLOG_STATE_DIR/evidence/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$attempt"
printf 'started\n' > "$attempt/status"
finish() { local status=$?; if ((status)); then printf 'failed\n' > "$attempt/status"; echo "Deployment failed; inspect $attempt and the selected container. No automatic schema rollback." >&2; fi; exit "$status"; }
trap finish EXIT
id="$(docker compose ps --all -q "$CLOG_SERVICE")"
if [[ -n "$id" ]]; then
  id="$(service_container)"
  if [[ "$(docker inspect --format '{{.State.Running}}' "$id")" != true ]]; then
    docker start "$id" >/dev/null
    for _attempt in $(seq 1 120); do
      phase="$(docker exec --user 0 "$id" clog status 2>/dev/null | jq -r .phase || true)"
      if [[ "$phase" == running || "$phase" == failed || "$phase" == maintenance ]]; then break; fi
      sleep 1
    done
  fi
  # Check the candidate's migration contract against the current live ledger first.
  docker exec -i --user 0 "$id" clog check-schema < "$CLOG_RELEASE_DIR/manifest.json" > "$attempt/preflight.json"
  phase="$(docker exec --user 0 "$id" clog status | jq -er .phase)"
  if [[ "$phase" == running ]]; then
    bash "$CLOG_RELEASE_DIR/infra/backup.sh" "$CLOG_STATE_DIR/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$" "$CLOG_SERVICE"
  else
    # A failed bootstrap has no writers and cannot claim a new versioned capture.
    # Retain and verify the last successful capture before an explicit recovery update.
    [[ -f "$CLOG_STATE_DIR/latest-backup" ]] || { echo 'No verified pre-failure backup; recover explicitly before updating' >&2; exit 1; }
    verify_backup "$(cat "$CLOG_STATE_DIR/latest-backup")"
    printf 'Using verified pre-failure backup; no writers are running.\n' > "$attempt/recovery.txt"
  fi
fi
write_image_override "$RELEASE_IMAGE"
docker compose config --quiet
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 180 "$CLOG_SERVICE"
id="$(service_container)"
docker exec --user 0 "$id" clog schema > "$attempt/schema.json"
jq -n --arg image "$RELEASE_IMAGE" --arg imageId "$(docker inspect --format '{{.Image}}' "$id")" --arg infrastructure "$CLOG_RELEASE_DIR" --arg service "$CLOG_SERVICE" --slurpfile schema "$attempt/schema.json" --slurpfile manifest "$CLOG_RELEASE_DIR/manifest.json" '{format:2,revision:$manifest[0].revision,image:$image,imageId:$imageId,infrastructure:$infrastructure,service:$service,evidence:$manifest[0].evidence,schema:$schema[0]}' > "$attempt/release.json"
if [[ -f "$CLOG_STATE_DIR/current-release.json" ]]; then cp "$CLOG_STATE_DIR/current-release.json" "$CLOG_STATE_DIR/previous-release.json"; fi
cp "$attempt/release.json" "$CLOG_STATE_DIR/current-release.json.tmp"
mv "$CLOG_STATE_DIR/current-release.json.tmp" "$CLOG_STATE_DIR/current-release.json"
printf 'passed\n' > "$attempt/status"
echo "Healthy pinned release. Evidence: $attempt"

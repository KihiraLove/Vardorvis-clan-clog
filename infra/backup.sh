#!/usr/bin/env bash
# Consistent backup of one installation in any Compose project.
set -euo pipefail
umask 077
# shellcheck source=infra/release-compose.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-compose.sh"
target="${1:?Usage: backup.sh NEW_DIRECTORY [SERVICE]}"
select_service "${2:-}"
lock_service
[[ ! -e "$target" ]] || { echo 'Backup directory already exists' >&2; exit 1; }
id="$(service_container)"
image_id="$(docker inspect --format '{{.Image}}' "$id")"
image="$(resolved_image "$image_id")"
project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")"
mkdir -p "$target"
archive="$(mktemp)"
finish() { local status=$?; rm -f "$archive"; if ((status)); then rm -f "$target/COMPLETE"; echo 'Backup incomplete; inspect clog status before resuming a paused installation.' >&2; fi; exit "$status"; }
trap finish EXIT
# The in-container operation owns the pause/resume lock for the complete capture.
docker exec --user 0 "$id" clog backup > "$archive"
tar --no-same-owner --exclude='./COMPLETE' -xzf "$archive" -C "$target"
# Bind capture to the same container, actual image and Compose service.
[[ "$(service_container)" == "$id" && "$(docker inspect --format '{{.Image}}' "$id")" == "$image_id" ]] || exit 1
jq --arg image "$image" --arg imageId "$image_id" --arg project "$project" --arg service "$CLOG_SERVICE" '. + {image:$image,imageId:$imageId,project:$project,service:$service}' "$target/release.json" > "$target/release.json.tmp"
mv "$target/release.json.tmp" "$target/release.json"
(cd "$target" && sha256sum release.json schema.json > META-SHA256SUMS)
verify_backup "$(realpath "$target")" --capture
printf 'complete\n' > "$target/COMPLETE.tmp"
mv "$target/COMPLETE.tmp" "$target/COMPLETE"
realpath "$target" > "$CLOG_STATE_DIR/latest-backup.tmp"
mv "$CLOG_STATE_DIR/latest-backup.tmp" "$CLOG_STATE_DIR/latest-backup"
echo "Completed backup: $target"

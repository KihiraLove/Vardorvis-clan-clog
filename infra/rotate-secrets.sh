#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=infra/release-compose.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-compose.sh"
kind="${1:?Usage: rotate-secrets.sh postgres|app|session [--resume] [SERVICE]}"
[[ "$kind" == postgres || "$kind" == app || "$kind" == session ]] || exit 1
shift
arguments=("$kind")
if [[ "${1:-}" == --resume ]]; then arguments+=(--resume); shift; fi
select_service "${1:-}"
lock_service
id="$(service_container)"
if [[ "${arguments[1]:-}" != --resume ]]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/backup.sh" "$CLOG_STATE_DIR/backups/pre-rotation-$(date -u +%Y%m%dT%H%M%SZ)-$$" "$CLOG_SERVICE"
fi
if ! docker exec --user 0 "$id" clog rotate "${arguments[@]}"; then
  echo 'Rotation incomplete; writers remain paused. Repair access and repeat with --resume.' >&2
  exit 1
fi
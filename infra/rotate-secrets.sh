#!/usr/bin/env bash
# Explicit maintenance under the same deployment/backup lock. Never display credentials.
set -euo pipefail
umask 077
kind="${1:?Choose postgres, app or session}"
[[ "$kind" == postgres || "$kind" == app || "$kind" == session ]] || exit 1
resume="${2:-}"
[[ -z "$resume" || "$resume" == --resume ]] || exit 1
versioned=false
if [[ -f .current-release.json ]]; then
  export CLOG_DEPLOY_ROOT CLOG_DEPLOY_PROJECT CLOG_RELEASE_DIR RELEASE_IMAGE RELEASE_DB_IMAGE
  CLOG_DEPLOY_ROOT="$(pwd -P)"
  CLOG_DEPLOY_PROJECT="$(jq -er .project .current-release.json)"
  CLOG_RELEASE_DIR="$(jq -er .infrastructure .current-release.json)"
  [[ "$CLOG_RELEASE_DIR" == "$CLOG_DEPLOY_ROOT/releases/"* && ! -L "$CLOG_RELEASE_DIR" ]] || exit 1
  (cd "$CLOG_RELEASE_DIR" && sha256sum --check SHA256SUMS >/dev/null)
  RELEASE_IMAGE="$(jq -er .image .current-release.json)"
  RELEASE_DB_IMAGE="$(jq -er .dbImage .current-release.json)"
  source "$CLOG_RELEASE_DIR/infra/release-compose.sh"
  configure_release
  versioned=true
fi
exec 9>.deploy.lock
flock -n 9 || { echo 'Another maintenance operation is running' >&2; exit 1; }
if [[ -z "$resume" ]]; then
  BACKUP_DEPLOY_LOCK_HELD=1 bash "$(dirname "${BASH_SOURCE[0]}")/backup.sh" "backups/pre-rotation-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi
docker compose stop app
arguments=("--rotate=$kind")
if [[ -n "$resume" ]]; then arguments+=(--resume); fi
if ! docker compose run --rm --no-deps -T init "${arguments[@]}"; then
  echo 'Rotation incomplete. Keep the application stopped and repeat this command with --resume after repairing access.' >&2
  exit 1
fi
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 app
if [[ "$versioned" == true ]]; then
  jq --arg checksum "$(configuration_checksum)" '.configurationChecksum=$checksum' .current-release.json > .current-release.json.tmp
  mv .current-release.json.tmp .current-release.json
fi
echo 'Secret rotation completed and application readiness verified.'

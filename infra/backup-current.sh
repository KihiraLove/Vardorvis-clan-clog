#!/usr/bin/env bash
set -euo pipefail
umask 077
export CLOG_DEPLOY_ROOT="${CLOG_DEPLOY_ROOT:-/srv/vardorvis-clan-clog}"
export CLOG_DEPLOY_PROJECT="${CLOG_DEPLOY_PROJECT:-vardorvis-clog}"
cd "$CLOG_DEPLOY_ROOT"
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment/backup is in progress' >&2; exit 1; }
export CLOG_RELEASE_DIR RELEASE_IMAGE
CLOG_RELEASE_DIR="$(jq -er .infrastructure .current-release.json)"
[[ "$CLOG_RELEASE_DIR" == "$CLOG_DEPLOY_ROOT/releases/"* && ! -L "$CLOG_RELEASE_DIR" ]] || exit 1
(cd "$CLOG_RELEASE_DIR" && sha256sum --check SHA256SUMS >/dev/null)
RELEASE_IMAGE="$(jq -er .image .current-release.json)"
export CLOG_USE_TRAEFIK
CLOG_USE_TRAEFIK="$(jq -r '.traefik | if type == "boolean" then tostring else "true" end' .current-release.json)"
source "$CLOG_RELEASE_DIR/infra/release-compose.sh"
configure_release
BACKUP_DEPLOY_LOCK_HELD=1 bash "$CLOG_RELEASE_DIR/infra/backup.sh" "${1:?Supply a new backup directory}"

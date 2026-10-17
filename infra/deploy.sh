#!/usr/bin/env bash
set -euo pipefail

# Installed launcher: execute infrastructure from the approved, resolved release image.
umask 077
launcher_path="$(realpath "${BASH_SOURCE[0]}")"
release_sha="${1:-}"
[[ $# -le 2 && ( -z "${2:-}" || "${2:-}" == --setup-admin ) ]] || { echo 'Usage: deploy.sh RELEASE_SHA [--setup-admin]' >&2; exit 1; }
export CLOG_SETUP_ADMIN=false
if [[ "${2:-}" == --setup-admin ]]; then CLOG_SETUP_ADMIN=true; fi
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full lowercase commit SHA' >&2; exit 1; }
export CLOG_DEPLOY_ROOT="${CLOG_DEPLOY_ROOT:-/srv/clan-collection-log}"
export CLOG_DEPLOY_PROJECT="${CLOG_DEPLOY_PROJECT:-clan-clog}"
[[ -d "$CLOG_DEPLOY_ROOT" && ! -L "$CLOG_DEPLOY_ROOT" ]] || exit 1
cd "$CLOG_DEPLOY_ROOT"
if [[ "$CLOG_DEPLOY_PROJECT" != clan-clog ]]; then
  [[ "$CLOG_DEPLOY_PROJECT" =~ ^clog-(release|restore)-[a-z0-9-]+$ && -f .isolated ]] || { echo 'Invalid isolated deployment target' >&2; exit 1; }
fi
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment/backup is in progress' >&2; exit 1; }
image="${CLOG_IMAGE_NAME:-ghcr.io/kihiralove/clan-clog}:sha-$release_sha"
if [[ "$CLOG_DEPLOY_PROJECT" == clan-clog ]]; then docker pull "$image"; fi
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" == "$release_sha" ]] || { echo 'Release image revision mismatch' >&2; exit 1; }
export CLOG_LAUNCHER_SHA256
CLOG_LAUNCHER_SHA256="$(sha256sum "$launcher_path" | cut -d' ' -f1)"
mkdir -p releases
temporary="$(mktemp -d releases/.extract.XXXXXX)"
container=''
finish() { local status=$?; [[ -z "$container" ]] || docker rm "$container" >/dev/null; if [[ -n "$temporary" ]]; then rm -rf -- "$temporary"; fi; exit "$status"; }
trap finish EXIT
container="$(docker create "$image_id")"
docker cp "$container:/opt/clog-release/." "$temporary/"
docker rm "$container" >/dev/null
container=''
(cd "$temporary" && sha256sum --check SHA256SUMS >/dev/null)
[[ "$(jq -er .revision "$temporary/manifest.json")" == "$release_sha" ]] || exit 1
export CLOG_RELEASE_DIR="$CLOG_DEPLOY_ROOT/releases/$release_sha-${image_id#sha256:}"
if [[ -e "$CLOG_RELEASE_DIR" ]]; then
  [[ ! -L "$CLOG_RELEASE_DIR" ]] || exit 1
  (cd "$CLOG_RELEASE_DIR" && sha256sum --check SHA256SUMS >/dev/null)
  cmp "$temporary/manifest.json" "$CLOG_RELEASE_DIR/manifest.json"
else
  mv "$temporary" "$CLOG_RELEASE_DIR"
  temporary=''
fi
export RELEASE_IMAGE
source "$CLOG_RELEASE_DIR/infra/release-compose.sh"
RELEASE_IMAGE="$(resolved_image "$image_id")"
if [[ "$CLOG_DEPLOY_PROJECT" == clan-clog ]]; then [[ "$RELEASE_IMAGE" == *@sha256:* ]] || { echo 'Registry digest required' >&2; exit 1; }; fi
export RELEASE_DB_IMAGE
if [[ -f .current-release.json ]]; then
  RELEASE_DB_IMAGE="$(jq -er .dbImage .current-release.json)"
else
  if [[ "$CLOG_DEPLOY_PROJECT" == clan-clog ]]; then docker pull postgres:17-alpine; fi
  RELEASE_DB_IMAGE="$(resolved_image "$(docker image inspect --format '{{.Id}}' postgres:17-alpine)")"
fi
docker image inspect "$RELEASE_DB_IMAGE" >/dev/null
bash "$CLOG_RELEASE_DIR/infra/deploy-release.sh"

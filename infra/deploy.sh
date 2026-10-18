#!/usr/bin/env bash
# Optional pinned updater, scoped to one service in the caller's Compose project.
set -euo pipefail
umask 077
# shellcheck source=infra/release-compose.sh
source "$(dirname "${BASH_SOURCE[0]}")/release-compose.sh"
revision="${1:?Usage: deploy.sh FULL_COMMIT_SHA [SERVICE]}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full lowercase commit SHA' >&2; exit 1; }
if [[ -n "${CLOG_DEPLOY_ROOT:-}" ]]; then cd "$CLOG_DEPLOY_ROOT"; fi
select_service "${2:-}"
lock_service
image="${CLOG_IMAGE_NAME:-ghcr.io/kihiralove/clan-clog}:sha-$revision"
if [[ "${CLOG_LOCAL_IMAGE:-false}" != true ]]; then docker pull "$image"; fi
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" == "$revision" ]] || { echo 'Release image revision mismatch' >&2; exit 1; }
mkdir -p "$CLOG_STATE_DIR/releases"
staging="$(mktemp -d "$CLOG_STATE_DIR/releases/.extract.XXXXXX")"
container=''
finish() { local status=$?; [[ -z "$container" ]] || docker rm "$container" >/dev/null; rm -rf -- "$staging"; exit "$status"; }
trap finish EXIT
container="$(docker create "$image_id")"
docker cp "$container:/opt/clog-release/." "$staging/"
docker rm "$container" >/dev/null
container=''
(cd "$staging" && sha256sum --check SHA256SUMS >/dev/null)
[[ "$(jq -er .revision "$staging/manifest.json")" == "$revision" ]] || exit 1
release_dir="$CLOG_STATE_DIR/releases/$revision-${image_id#sha256:}"
if [[ -e "$release_dir" ]]; then
  (cd "$release_dir" && sha256sum --check SHA256SUMS >/dev/null)
  cmp "$staging/manifest.json" "$release_dir/manifest.json"
else
  mv "$staging" "$release_dir"
fi
export CLOG_RELEASE_DIR="$release_dir" RELEASE_IMAGE
RELEASE_IMAGE="$(resolved_image "$image_id")"
if [[ "${CLOG_LOCAL_IMAGE:-false}" != true ]]; then [[ "$RELEASE_IMAGE" == *@sha256:* ]] || exit 1; fi
# Execute the verified release's helper after all candidate validation.
bash "$CLOG_RELEASE_DIR/infra/deploy-release.sh"
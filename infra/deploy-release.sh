#!/usr/bin/env bash
# The launcher's lock spans backup, migration, runtime health and evidence publication.
set -euo pipefail
umask 077
source "${CLOG_RELEASE_DIR:?}/infra/release-compose.sh"
configure_release
docker compose config --quiet
mkdir -p evidence backups
attempt="evidence/deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$attempt"
printf 'started\n' > "$attempt/status"
jq -n --arg revision "$IMAGE_TAG" --arg image "$RELEASE_IMAGE" '{revision:$revision,image:$image}' > "$attempt/candidate.json"
finish() { local status=$?; if ((status)); then printf 'failed; inspect pinned manifest and schema before recovery\n' > "$attempt/status"; echo "Deployment failed. Evidence: $attempt; no automatic image/schema rollback." >&2; fi; exit "$status"; }
trap finish EXIT
docker image inspect "$RELEASE_IMAGE" >/dev/null
running_db="$(docker compose ps --status running -q db)"
if [[ -n "$running_db" ]]; then
  docker compose run --rm --no-deps -T migrate node packages/database/dist/release-state.js > "$attempt/preflight.json"
  if [[ -f .current-release.json ]]; then
    candidate_dir="$CLOG_RELEASE_DIR" candidate_image="$RELEASE_IMAGE" candidate_traefik="${CLOG_USE_TRAEFIK:-true}"
    current_dir="$(jq -er .infrastructure .current-release.json)"
    [[ "$current_dir" == "$CLOG_DEPLOY_ROOT/releases/"* && -d "$current_dir" && ! -L "$current_dir" ]] || exit 1
    (cd "$current_dir" && sha256sum --check SHA256SUMS >/dev/null)
    export CLOG_RELEASE_DIR="$current_dir"
    CLOG_USE_TRAEFIK="$(jq -r '.traefik | if type == "boolean" then tostring else "true" end' .current-release.json)"
    RELEASE_IMAGE="$(jq -er .image .current-release.json)"; export RELEASE_IMAGE
    configure_release
    BACKUP_DEPLOY_LOCK_HELD=1 bash "$current_dir/infra/backup.sh" "$CLOG_DEPLOY_ROOT/backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    export CLOG_RELEASE_DIR="$candidate_dir" RELEASE_IMAGE="$candidate_image"
    CLOG_USE_TRAEFIK="$candidate_traefik"
    configure_release
  elif [[ -n "$(docker compose ps --status running -q app)" ]]; then
    echo 'Existing unversioned deployment requires a coordinated legacy backup and inventory before adoption.' >&2; exit 1
  fi
fi
docker compose stop app
docker compose up -d --wait --wait-timeout 120 db
docker compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate > "$attempt/bootstrap.log" 2>&1
docker compose run --rm --no-deps -T migrate node packages/database/dist/release-state.js --exact > "$attempt/schema.json"
if [[ "${CLOG_SETUP_ADMIN:-false}" == true ]]; then docker compose run --rm --no-deps -T setup-admin --generate; fi
docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 app
db_id="$(docker compose ps -q db)"
db_image="$(resolved_image "$(docker inspect --format '{{.Image}}' "$db_id")")"
jq -n --arg revision "$IMAGE_TAG" --arg image "$RELEASE_IMAGE" --arg imageId "$(docker image inspect --format '{{.Id}}' "$RELEASE_IMAGE")" --arg dbImage "$db_image" --arg infrastructure "$CLOG_RELEASE_DIR" --arg launcher "$CLOG_LAUNCHER_SHA256" --arg bundle "$(sha256sum "$CLOG_RELEASE_DIR/manifest.json" | cut -d' ' -f1)" --slurpfile schema "$attempt/schema.json" --slurpfile manifest "$CLOG_RELEASE_DIR/manifest.json" '{format:1,revision:$revision,image:$image,imageId:$imageId,dbImage:$dbImage,infrastructure:$infrastructure,launcherChecksum:$launcher,bundleChecksum:$bundle,evidence:$manifest[0].evidence,schema:$schema[0]}' > "$attempt/release.json"
if [[ -f .current-release.json ]]; then cp .current-release.json .previous-release.json.tmp; mv .previous-release.json.tmp .previous-release.json; fi
jq --arg project "$CLOG_DEPLOY_PROJECT" --arg files "$COMPOSE_FILE" --arg config "$(configuration_checksum)" --argjson traefik "$(if [[ "$CLOG_DEPLOY_PROJECT" == clan-clog ]]; then printf '%s' "${CLOG_USE_TRAEFIK:-true}"; else printf false; fi)" '. + {project:$project,composeFiles:($files|split(":")),configurationChecksum:$config,traefik:$traefik}' "$attempt/release.json" > "$attempt/release-metadata.json"
mv "$attempt/release-metadata.json" "$attempt/release.json"
cp "$attempt/release.json" .current-release.json.tmp
mv .current-release.json.tmp .current-release.json
printf '%s\n' "$CLOG_RELEASE_DIR" > .current-infrastructure.tmp
mv .current-infrastructure.tmp .current-infrastructure
printf '%s\n' "$IMAGE_TAG" > .current-release
printf 'passed\n' > "$attempt/status"
echo "Healthy pinned release. Evidence: $attempt"

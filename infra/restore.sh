#!/usr/bin/env bash
# Restore only to a new, isolated namespace. Existing data is never overwritten.
set -euo pipefail
umask 077
backup="$(realpath "${1:?Supply a completed versioned backup}")"
export CLOG_DEPLOY_PROJECT="${2:?Supply a new clog-restore-* project}"
export CLOG_DEPLOY_ROOT
CLOG_DEPLOY_ROOT="$(realpath "${3:?Supply an empty recovery directory containing .env}")"
[[ "$CLOG_DEPLOY_PROJECT" =~ ^clog-restore-[a-z0-9-]+$ ]] || { echo 'Use a fresh isolated restore project' >&2; exit 1; }
[[ "$backup" != "$CLOG_DEPLOY_ROOT" && -f "$backup/COMPLETE" && -f "$backup/release.json" && ! -L "$backup" ]] || exit 1
# Reject reused namespaces before any creation/deletion or restore operation.
for kind in container network volume; do
  case "$kind" in
    container) existing="$(docker ps -aq --filter "label=com.docker.compose.project=$CLOG_DEPLOY_PROJECT")" ;;
    network) existing="$(docker network ls -q --filter "label=com.docker.compose.project=$CLOG_DEPLOY_PROJECT")" ;;
    volume) existing="$(docker volume ls -q --filter "label=com.docker.compose.project=$CLOG_DEPLOY_PROJECT")" ;;
  esac
  [[ -z "$existing" ]] || { echo 'Restore namespace already exists; no resources changed' >&2; exit 1; }
done
[[ -f "$CLOG_DEPLOY_ROOT/.env" && ! -L "$CLOG_DEPLOY_ROOT/.env" && ! -e "$CLOG_DEPLOY_ROOT/releases" ]] || exit 1
[[ -z "$(find "$CLOG_DEPLOY_ROOT" -mindepth 1 -maxdepth 1 ! -name .env -print -quit)" ]] || { echo 'Recovery directory must contain only .env' >&2; exit 1; }
volume_names="$(docker volume ls --format '{{.Name}}')"
network_names="$(docker network ls --format '{{.Name}}')"
for name in postgres-data catalog-icons submission-images; do
  if grep -Fxq "${CLOG_DEPLOY_PROJECT}_$name" <<< "$volume_names"; then echo 'Restore volume name already exists' >&2; exit 1; fi
done
if grep -Fxq "${CLOG_DEPLOY_PROJECT}_default" <<< "$network_names"; then echo 'Restore network name already exists' >&2; exit 1; fi
exec 9>"$CLOG_DEPLOY_ROOT/.restore.lock"
flock -n 9 || { echo 'Another restore is using this directory' >&2; exit 1; }
[[ "$(cat "$backup/COMPLETE")" == complete ]] || exit 1
(cd "$backup" && sha256sum --check SHA256SUMS && sha256sum --check META-SHA256SUMS) >/dev/null
(cd "$backup/infrastructure" && sha256sum --check SHA256SUMS) >/dev/null
[[ "$(jq -er .bundleChecksum "$backup/release.json")" == "$(sha256sum "$backup/infrastructure/manifest.json" | cut -d' ' -f1)" ]] || exit 1
[[ "$(jq -er .revision "$backup/release.json")" == "$(jq -er .revision "$backup/infrastructure/manifest.json")" ]] || exit 1
# Archives contain only regular files/directories, with confined generated names.
for archive in icons.tar.gz screenshots.tar.gz; do
  tar -tvzf "$backup/$archive" | awk 'substr($1,1,1)!="-" && substr($1,1,1)!="d" {exit 1}'
  while IFS= read -r member; do
    [[ "$member" =~ ^\./[A-Za-z0-9_./-]*$ && ! "$member" =~ (^|/)\.\.(/|$) ]] || { echo 'Unsafe restore archive member' >&2; exit 1; }
  done < <(tar -tzf "$backup/$archive")
done
export RELEASE_IMAGE RELEASE_DB_IMAGE CLOG_RELEASE_DIR
RELEASE_IMAGE="$(jq -er .image "$backup/release.json")"
RELEASE_DB_IMAGE="$(jq -er .dbImage "$backup/release.json")"
[[ "$RELEASE_IMAGE" =~ (^sha256:[a-f0-9]{64}$|@sha256:[a-f0-9]{64}$) && "$RELEASE_DB_IMAGE" =~ (^sha256:[a-f0-9]{64}$|@sha256:[a-f0-9]{64}$) ]] || exit 1
docker image inspect "$RELEASE_IMAGE" "$RELEASE_DB_IMAGE" >/dev/null
[[ "$(docker image inspect --format '{{.Id}}' "$RELEASE_IMAGE")" == "$(jq -er .imageId "$backup/release.json")" ]] || { echo 'Restored image/platform does not match backup' >&2; exit 1; }
mkdir -p "$CLOG_DEPLOY_ROOT/releases/restored" "$CLOG_DEPLOY_ROOT/evidence"
claim=''
finish() {
  local status=$?
  if [[ -n "$claim" ]]; then docker rm "$claim" >/dev/null || status=1; fi
  if ((status)); then printf 'failed; isolated resources retained for inspection\n' > "$CLOG_DEPLOY_ROOT/evidence/restore-status"; echo 'Restore failed; inspect the isolated project and evidence before cleanup.' >&2; fi
  exit "$status"
}
trap finish EXIT
claim="$(docker create --name "$CLOG_DEPLOY_PROJECT-restore-claim" --label "com.docker.compose.project=$CLOG_DEPLOY_PROJECT" "$RELEASE_IMAGE")"
cp -a "$backup/infrastructure/." "$CLOG_DEPLOY_ROOT/releases/restored/"
touch "$CLOG_DEPLOY_ROOT/.isolated"
CLOG_RELEASE_DIR="$CLOG_DEPLOY_ROOT/releases/restored"
source "$CLOG_RELEASE_DIR/infra/release-compose.sh"
configure_release
printf 'started\n' > evidence/restore-status
docker compose config --quiet
docker compose up -d --wait --wait-timeout 120 db
docker compose exec -T db pg_restore --exit-on-error --no-owner --no-privileges -U clog -d clog < "$backup/database.dump"
# Validate the restored ledger before starting any application process.
docker compose run --rm --no-deps -T migrate node packages/database/dist/release-state.js --exact > evidence/schema.json
for volume in icons screenshots; do
  if [[ "$volume" == icons ]]; then directory=/data/catalog-icons; else directory=/data/submission-images; fi
  docker compose run --rm --no-deps -T --user 0 --entrypoint sh app -c 'tar --no-same-owner -xzf - -C "$1" && chown -R node:node "$1"' sh "$directory" < "$backup/$volume.tar.gz"
done
# pg_dump omits global roles; bootstrap recreates the restricted runtime role without replacing data.
docker compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate > evidence/bootstrap.log 2>&1
docker compose up -d --no-deps --wait --wait-timeout 120 app
jq --arg project "$CLOG_DEPLOY_PROJECT" --arg infrastructure "$CLOG_RELEASE_DIR" --arg files "$COMPOSE_FILE" --arg config "$(sha256sum "$CLOG_DEPLOY_ROOT/.env" | cut -d' ' -f1)" '. + {restoredFrom:{revision:.revision,image:.image,bundleChecksum:.bundleChecksum},project:$project,infrastructure:$infrastructure,composeFiles:($files|split(":")),configurationChecksum:$config,traefik:false}' "$backup/release.json" > .current-release.json
printf '%s\n' "$CLOG_RELEASE_DIR" > .current-infrastructure
printf 'passed\n' > evidence/restore-status
echo 'Isolated database and both filesystem volumes restored; run the semantic acceptance checks before cutover.'

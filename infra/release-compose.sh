#!/usr/bin/env bash
# Shared Compose selection. Never enumerate or stop unrelated services.
select_service() {
  export CLOG_SERVICE="${1:-${CLOG_SERVICE:-clan-clog}}"
  [[ "$CLOG_SERVICE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid service name' >&2; return 1; }
  export CLOG_STATE_DIR="$PWD/.clog/$CLOG_SERVICE"
  mkdir -p "$CLOG_STATE_DIR"
  if [[ -z "${COMPOSE_FILE:-}" ]]; then
    local base
    for base in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
      if [[ -f "$base" ]]; then export COMPOSE_FILE="$base"; break; fi
    done
    : "${COMPOSE_FILE:?Run in the Compose directory or set COMPOSE_FILE}"
    for base in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
      if [[ -f "$base" ]]; then export COMPOSE_FILE="$COMPOSE_FILE:$base"; break; fi
    done
  fi
  if [[ -f "$CLOG_STATE_DIR/image.yaml" && ":$COMPOSE_FILE:" != *":$CLOG_STATE_DIR/image.yaml:"* ]]; then
    export COMPOSE_FILE="$COMPOSE_FILE:$CLOG_STATE_DIR/image.yaml"
  fi
  docker compose config --format json | jq -e --arg service "$CLOG_SERVICE" '.services[$service] != null' >/dev/null
}
service_container() {
  local ids
  ids="$(docker compose ps --all -q "$CLOG_SERVICE")" || return 1
  [[ -n "$ids" && "$ids" != *$'\n'* ]] || { echo 'Expected exactly one selected service container' >&2; return 1; }
  [[ "$(docker inspect --format '{{index .Config.Labels "io.clog.service"}}' "$ids")" == installation ]] || { echo 'Selected service is not a Clan Collection Log installation' >&2; return 1; }
  printf '%s\n' "$ids"
}
lock_service() {
  if [[ "${CLOG_LOCK_HELD:-}" != "$CLOG_SERVICE" ]]; then
    exec 9>"$CLOG_STATE_DIR/operation.lock"
    flock -n 9 || { echo 'Another operation is using this installation' >&2; return 1; }
    export CLOG_LOCK_HELD="$CLOG_SERVICE"
  fi
}
resolved_image() {
  local id="$1" digest
  digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$id")" || return 1
  printf '%s\n' "${digest:-$id}"
}
write_image_override() {
  jq -n --arg service "$CLOG_SERVICE" --arg image "$1" '{services:{($service):{image:$image,pull_policy:"never"}}}' > "$CLOG_STATE_DIR/image.yaml.tmp"
  mv "$CLOG_STATE_DIR/image.yaml.tmp" "$CLOG_STATE_DIR/image.yaml"
  if [[ ":$COMPOSE_FILE:" != *":$CLOG_STATE_DIR/image.yaml:"* ]]; then export COMPOSE_FILE="$COMPOSE_FILE:$CLOG_STATE_DIR/image.yaml"; fi
}
verify_backup() {
  local backup="$1" image
  [[ -d "$backup" && ! -L "$backup" ]] || return 1
  [[ "${2:-}" == --capture || -f "$backup/COMPLETE" ]] || return 1
  image="$(jq -er .image "$backup/release.json")" || return 1
  [[ "$image" =~ (^sha256:[a-f0-9]{64}$|@sha256:[a-f0-9]{64}$) ]] || return 1
  [[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$(jq -er .imageId "$backup/release.json")" ]] || { echo 'Recorded image is unavailable or does not match this platform' >&2; return 1; }
  # Stream instead of bind-mounting host paths: also works with a remote Docker
  # engine and when the operator's tooling runs inside a container.
  tar -C "$backup" -czf - . | docker run --rm -i --network none --entrypoint node "$image" apps/api/dist/maintenance.js verify-archive "${2:-}"
}

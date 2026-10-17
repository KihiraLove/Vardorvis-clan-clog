#!/usr/bin/env bash
# Source from a verified bundle. Secrets stay in the host's restricted env file.
configure_release() {
  : "${CLOG_DEPLOY_ROOT:?}" "${CLOG_RELEASE_DIR:?}" "${RELEASE_IMAGE:?}" "${CLOG_DEPLOY_PROJECT:?}"
  [[ -f "$CLOG_DEPLOY_ROOT/.env" && ! -L "$CLOG_DEPLOY_ROOT/.env" ]] || { echo 'A regular restricted .env is required' >&2; return 1; }
  export COMPOSE_PROJECT_NAME="$CLOG_DEPLOY_PROJECT" COMPOSE_DISABLE_ENV_FILE=true
  export COMPOSE_ENV_FILES="$CLOG_DEPLOY_ROOT/.env" IMAGE_TAG
  IMAGE_TAG="$(jq -er .revision "$CLOG_RELEASE_DIR/manifest.json")"
  export COMPOSE_FILE="$CLOG_RELEASE_DIR/compose.yaml:$CLOG_RELEASE_DIR/compose.release.yaml"
  # The selected host/clone env file is authoritative, never the caller's application secrets.
  unset POSTGRES_PASSWORD APP_DB_PASSWORD AUTH_ENABLED PUBLIC_ORIGIN SESSION_SECRET ADMIN_BOOTSTRAP_PASSWORD BOT_ENABLED BOT_API_TOKEN DISCORD_BOT_TOKEN DISCORD_GUILD_ID DISCORD_APPLICATION_ID DISCORD_TEST_GUILD_ID TRUSTED_PROXY_CIDRS IMAGE_NAME WEB_PORT CLOG_HOST TRAEFIK_HTTPS_ENTRYPOINT TRAEFIK_CERT_RESOLVER
  unset BOT_INTAKE_USER_PER_MINUTE BOT_INTAKE_GUILD_PER_MINUTE BOT_SEARCH_USER_PER_MINUTE BOT_SEARCH_GUILD_PER_MINUTE
  unset COMPOSE_PROFILES
  if [[ "$CLOG_DEPLOY_PROJECT" == clan-clog ]]; then
    if [[ -z "${CLOG_USE_TRAEFIK:-}" && -f "$CLOG_DEPLOY_ROOT/.current-release.json" ]]; then
      CLOG_USE_TRAEFIK="$(jq -er '.traefik | if type == "boolean" then tostring else "true" end' "$CLOG_DEPLOY_ROOT/.current-release.json")"
    fi
    [[ "${CLOG_USE_TRAEFIK:-true}" == true || "${CLOG_USE_TRAEFIK:-true}" == false ]] || return 1
    if [[ "${CLOG_USE_TRAEFIK:-true}" == true ]]; then export COMPOSE_FILE="$COMPOSE_FILE:$CLOG_RELEASE_DIR/compose.traefik.yaml"; fi
  else
    [[ "$CLOG_DEPLOY_PROJECT" =~ ^clog-(release|restore)-[a-z0-9-]+$ && -f "$CLOG_DEPLOY_ROOT/.isolated" ]] || { echo 'An isolated project and marker are required' >&2; return 1; }
    export COMPOSE_FILE="$COMPOSE_FILE:$CLOG_RELEASE_DIR/compose.isolated.yaml"
  fi
  cd "$CLOG_DEPLOY_ROOT" || return 1
}
resolved_image() {
  local id="$1" digest
  digest="$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$id")" || return 1
  if [[ -n "$digest" ]]; then printf '%s\n' "$digest"; else printf '%s\n' "$id"; fi
}

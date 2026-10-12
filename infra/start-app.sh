#!/usr/bin/env bash
# Supervise the API, HTTP proxy, and optionally the Discord gateway together.
set -euo pipefail
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
on_signal() {
  trap - TERM INT
  cleanup
  exit 0
}
trap on_signal TERM INT
if [[ "${BOT_ENABLED:-false}" != true && "${BOT_ENABLED:-false}" != false ]]; then
  echo "BOT_ENABLED must be true or false" >&2
  exit 1
fi
if [[ "${BOT_ENABLED:-false}" == true ]]; then
  for variable in DISCORD_BOT_TOKEN DISCORD_GUILD_ID BOT_API_TOKEN; do
    if [[ -z "${!variable:-}" ]]; then
      echo "BOT_ENABLED=true requires $variable" >&2
      exit 1
    fi
  done
fi

# Nginx is the fixed immediate hop. Extend trust only to configured upstreams.
export TRUSTED_PROXY_CIDRS="127.0.0.1/32${TRUSTED_PROXY_CIDRS:+,${TRUSTED_PROXY_CIDRS}}"

node apps/api/dist/server.js &
pids+=("$!")
if [[ "${BOT_ENABLED:-false}" == true ]]; then
  node apps/bot/dist/index.js &
  pids+=("$!")
fi
nginx -g 'daemon off;' &
pids+=("$!")
set +e
wait -n "${pids[@]}"
status=$?
set -e
trap - TERM INT
cleanup
# An unexpectedly terminated component invalidates the entire application.
if ((status == 0)); then exit 1; fi
exit "$status"

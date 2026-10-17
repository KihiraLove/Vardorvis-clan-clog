#!/usr/bin/env bash
# Keep the website available during Discord outages; drain intake before the API.
set -euo pipefail
api_pid='' proxy_pid='' bot_pid='' retry_pid=''
cleanup_failed=0
stop_child() {
  local pid="$1" signal="$2" seconds="$3" component="$4" deadline status=0
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -s "$signal" "$pid" 2>/dev/null || true
    deadline=$((SECONDS + seconds))
    while kill -0 "$pid" 2>/dev/null; do
      if ((SECONDS >= deadline)); then
        printf '{"service":"supervisor","event":"shutdown","component":"%s","code":"DRAIN_EXPIRED"}\n' "$component" >&2
        kill -KILL "$pid" 2>/dev/null || true
        cleanup_failed=1
        break
      fi
      sleep 0.1
    done
  fi
  wait "$pid" 2>/dev/null || status=$?
  if ((status != 0)); then cleanup_failed=1; fi
}
cleanup() {
  trap '' TERM INT
  # Cancel restart backoff before considering any child shutdown.
  if [[ -n "$retry_pid" ]]; then kill -TERM "$retry_pid" 2>/dev/null || true; wait "$retry_pid" 2>/dev/null || true; retry_pid=''; fi
  stop_child "$bot_pid" TERM 37 bot
  stop_child "$api_pid" TERM 22 api
  stop_child "$proxy_pid" QUIT 5 proxy
}
on_signal() {
  cleanup
  exit "$cleanup_failed"
}
trap on_signal TERM INT
if [[ "${BOT_ENABLED:-false}" != true && "${BOT_ENABLED:-false}" != false ]]; then
  echo 'BOT_ENABLED must be true or false' >&2
  exit 1
fi
if [[ "${BOT_ENABLED:-false}" == true ]]; then
  for variable in DISCORD_BOT_TOKEN BOT_API_TOKEN; do
    file_variable="${variable}_FILE"
    if [[ -z "${!variable:-}" && -z "${!file_variable:-}" ]]; then echo "BOT_ENABLED=true requires $variable or ${variable}_FILE" >&2; exit 1; fi
  done
  if [[ -z "${DISCORD_GUILD_ID:-}" ]]; then echo 'BOT_ENABLED=true requires DISCORD_GUILD_ID' >&2; exit 1; fi
fi
export TRUSTED_PROXY_CIDRS="127.0.0.1/32${TRUSTED_PROXY_CIDRS:+,${TRUSTED_PROXY_CIDRS}}"
node apps/api/dist/server.js &
api_pid=$!
nginx -g 'daemon off;' &
proxy_pid=$!
backoff=1 bot_started=0
start_bot() {
  node apps/bot/dist/index.js &
  bot_pid=$!
  bot_started=$SECONDS
}
if [[ "${BOT_ENABLED:-false}" == true ]]; then start_bot; fi
while true; do
  watched=("$api_pid" "$proxy_pid")
  if [[ -n "$bot_pid" ]]; then watched+=("$bot_pid"); fi
  if [[ -n "$retry_pid" ]]; then watched+=("$retry_pid"); fi
  status=0 ended=''
  wait -n -p ended "${watched[@]}" || status=$?
  if [[ "$ended" == "$api_pid" || "$ended" == "$proxy_pid" ]]; then
    printf '{"service":"supervisor","event":"process","code":"PROCESS_FAILED","status":%d}\n' "$status" >&2
    cleanup
    if ((status == 0)); then exit 1; fi
    exit "$status"
  elif [[ -n "$bot_pid" && "$ended" == "$bot_pid" ]]; then
    if ((SECONDS - bot_started >= 60)); then backoff=1; fi
    printf '{"service":"supervisor","event":"process","component":"bot","code":"PROCESS_FAILED","status":%d,"retrySeconds":%d}\n' "$status" "$backoff" >&2
    bot_pid=''
    sleep "$backoff" &
    retry_pid=$!
    if ((backoff < 30)); then backoff=$((backoff * 2)); fi
    if ((backoff > 30)); then backoff=30; fi
  elif [[ -n "$retry_pid" && "$ended" == "$retry_pid" ]]; then
    retry_pid=''
    start_bot
  else
    cleanup
    exit 1
  fi
done

#!/usr/bin/env bash
# The same gates run locally and in explicitly requested GitHub CI.
set -euo pipefail
: "${TEST_DATABASE_URL:?The runner must supply a disposable test database}"
[[ "${COMPOSE_PROJECT_NAME:-}" =~ ^clog-checks-[a-z0-9-]+$ ]] || exit 1
export CI=true
export COMPOSE_FILE=compose.yaml:compose.checks.yaml
export COMPOSE_ENV_FILES=/dev/null
export COMPOSE_DISABLE_ENV_FILE=true
export CLOG_HOST=clog.example.com
exec node scripts/check-gates.mjs

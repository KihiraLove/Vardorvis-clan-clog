#!/usr/bin/env bash
# The same gates run locally and in explicitly requested GitHub CI.
set -euo pipefail
: "${TEST_DATABASE_URL:?The runner must supply a disposable test database}"
[[ "${COMPOSE_PROJECT_NAME:-}" =~ ^clog-checks-[a-z0-9-]+$ ]] || exit 1
export CI=true
export COMPOSE_FILE=compose.yaml:compose.checks.yaml
export COMPOSE_ENV_FILES=/dev/null
export COMPOSE_DISABLE_ENV_FILE=true
mkdir -p .data/local-checks
run_gate() {
  local gate="$1"
  shift
  printf '\nRunning %s\n' "$gate"
  "$@" 2>&1 | tee ".data/local-checks/$gate.log"
}
run_gate workflows actionlint -config-file .github/actionlint.yaml .github/workflows/*.yml
run_gate tools npm run test:tools
run_gate validate npm run validate
# A missing TEST_DATABASE_URL must never silently turn the full gate green.
if grep -Eq 'ℹ (skipped|todo) [1-9]' .data/local-checks/validate.log; then
  echo 'Full validation must not skip database tests or leave TODO tests.' >&2
  exit 1
fi
run_gate workloads node scripts/benchmark-workloads.mjs
run_gate projections env PROJECTION_BENCH_DISPOSABLE=true node scripts/benchmark-projections.mjs
run_gate browser npm run test:e2e -w @clog/web
run_gate smoke bash scripts/compose-smoke.sh
printf 'All local gates passed.\n'

#!/usr/bin/env bash
set -euo pipefail

# The workflow verifies CI provenance; this helper validates the release identity's shape.
release_sha="${1:-}"
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full lowercase commit SHA'; exit 1; }
cd /srv/vardorvis-clan-clog
umask 077
# Serialize host deployments independently of GitHub workflow concurrency.
exec 9>.deploy.lock
flock -n 9 || { echo 'Another deployment is in progress'; exit 1; }
export IMAGE_TAG="sha-$release_sha"
docker compose config --quiet
mkdir -p backups
# A failed dump must never appear as a completed backup; finish before changing images.
if [[ -n "$(docker compose ps --status running -q db)" ]]; then
  backup_path="backups/clog-$(date -u +%Y%m%dT%H%M%SZ)-$release_sha.dump"
  docker compose exec -T db pg_dump -U clog -d clog -Fc > "$backup_path.tmp"
  mv "$backup_path.tmp" "$backup_path"
fi
docker compose pull
# Failure may leave changed containers/schema; recovery requires an operator decision.
if ! docker compose up -d --wait --wait-timeout 120; then
  echo 'Deployment failed health checks. Inspect logs and use a compatible previous release or tested database restore.'
  exit 1
fi
if [[ -f .current-release ]]; then cp .current-release .previous-release; fi
# Record the successful tag with an atomic replacement that preserves other env settings.
env_update="$(mktemp .env.release.XXXXXX)"
awk -v tag="$IMAGE_TAG" '
  BEGIN { found = 0 }
  /^IMAGE_TAG=/ { print "IMAGE_TAG=" tag; found = 1; next }
  { print }
  END { if (!found) print "IMAGE_TAG=" tag }
' .env > "$env_update"
mv "$env_update" .env
printf '%s\n' "$IMAGE_TAG" > .current-release
echo "Healthy release: $IMAGE_TAG"

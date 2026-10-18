#!/usr/bin/env bash
set -euo pipefail
if (($#)); then exec "$@"; fi
mkdir -p /data/system
# The lifetime lock belongs to the installation, regardless of its Compose name.
exec flock --nonblock --conflict-exit-code 73 /data/system/installation.lock node apps/api/dist/installation.js "$@"

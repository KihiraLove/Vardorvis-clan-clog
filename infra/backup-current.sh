#!/usr/bin/env bash
set -euo pipefail
# Kept as a convenient alias; backups inspect the running installation directly.
exec bash "$(dirname "${BASH_SOURCE[0]}")/backup.sh" "$@"
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/stable-daemon-stop.sh" || true
sleep 1
"$SCRIPT_DIR/stable-daemon-start.sh" "$@"

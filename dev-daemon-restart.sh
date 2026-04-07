#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP_SCRIPT="$SCRIPT_DIR/dev-daemon-stop.sh"
START_SCRIPT="$SCRIPT_DIR/dev-daemon-start.sh"
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-1}"

usage() {
  cat <<'EOF'
Usage:
  ./dev-daemon-restart.sh [start options]

Examples:
  ./dev-daemon-restart.sh
  ./dev-daemon-restart.sh --reset-log

Environment:
  RESTART_DELAY_SECONDS  Wait time between stop and start (default: 1)
  FRONTEND_PORT          Passed through to start script
  BACKEND_PORT           Passed through to start script
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -x "$STOP_SCRIPT" ]]; then
  echo "[dev-daemon] ERROR: stop script not executable: $STOP_SCRIPT"
  exit 1
fi
if [[ ! -x "$START_SCRIPT" ]]; then
  echo "[dev-daemon] ERROR: start script not executable: $START_SCRIPT"
  exit 1
fi

echo "[dev-daemon] Restart: stopping..."
"$STOP_SCRIPT" || true

if [[ "$RESTART_DELAY_SECONDS" =~ ^[0-9]+$ ]] && [[ "$RESTART_DELAY_SECONDS" -gt 0 ]]; then
  sleep "$RESTART_DELAY_SECONDS"
fi

echo "[dev-daemon] Restart: starting..."
"$START_SCRIPT" "$@"

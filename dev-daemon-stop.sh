#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.dev-daemon"
PID_FILE="$STATE_DIR/dev.pid"
LOG_FILE="$STATE_DIR/dev.log"
STARTED_AT_FILE="$STATE_DIR/started_at"
GRACE_SECONDS="${GRACE_SECONDS:-15}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-shadowbroker-dev}"

usage() {
  cat <<'EOF'
Usage:
  ./dev-daemon-stop.sh

Environment:
  GRACE_SECONDS  Seconds to wait before force-kill (default: 15)
  TMUX_SESSION_NAME  tmux session name used for the dev daemon (default: shadowbroker-dev)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

if command -v tmux >/dev/null 2>&1 && has_tmux_session "$TMUX_SESSION_NAME"; then
  echo "[dev-daemon] Stopping tmux session $TMUX_SESSION_NAME ..."
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  rm -f "$PID_FILE"
  rm -f "$STARTED_AT_FILE"
  echo "[dev-daemon] Stopped."
  if [[ -f "$LOG_FILE" ]]; then
    echo "[dev-daemon] Logs kept at: $LOG_FILE"
  fi
  exit 0
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "[dev-daemon] Not running (no PID file)."
  exit 0
fi

PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
  echo "[dev-daemon] Invalid PID file, cleaning up."
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[dev-daemon] Process already stopped, cleaning stale PID."
  rm -f "$PID_FILE"
  exit 0
fi

echo "[dev-daemon] Stopping PID=$PID ..."
kill "$PID" 2>/dev/null || true

if command -v pkill >/dev/null 2>&1; then
  pkill -TERM -P "$PID" 2>/dev/null || true
fi

for _ in $(seq 1 "$GRACE_SECONDS"); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
  echo "[dev-daemon] Grace period exceeded, force killing PID=$PID"
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
rm -f "$STARTED_AT_FILE"
echo "[dev-daemon] Stopped."
if [[ -f "$LOG_FILE" ]]; then
  echo "[dev-daemon] Logs kept at: $LOG_FILE"
fi

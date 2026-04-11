#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.stable-daemon"
PID_FILE="$STATE_DIR/app.pid"
LOG_FILE="$STATE_DIR/app.log"
STARTED_AT_FILE="$STATE_DIR/started_at"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-shadowbroker-stable}"

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

if command -v tmux >/dev/null 2>&1 && has_tmux_session "$TMUX_SESSION_NAME"; then
  echo "[stable-daemon] Stopping tmux session $TMUX_SESSION_NAME ..."
  tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
fi

rm -f "$PID_FILE"
rm -f "$STARTED_AT_FILE"
echo "[stable-daemon] Stopped."
if [[ -f "$LOG_FILE" ]]; then
  echo "[stable-daemon] Logs kept at: $LOG_FILE"
fi

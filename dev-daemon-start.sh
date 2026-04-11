#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.dev-daemon"
PID_FILE="$STATE_DIR/dev.pid"
LOG_FILE="$STATE_DIR/dev.log"
STARTED_AT_FILE="$STATE_DIR/started_at"
FRONTEND_PORT="${FRONTEND_PORT:-6789}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-60}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-shadowbroker-dev}"

usage() {
  cat <<'EOF'
Usage:
  ./dev-daemon-start.sh [--reset-log]

Options:
  --reset-log   Truncate log file before starting
  -h, --help    Show this help

Environment:
  FRONTEND_PORT  Frontend port check/start target (default: 6789)
  BACKEND_PORT   Backend port check/start target (default: 8000)
  START_TIMEOUT_SECONDS  Seconds to wait for frontend listener readiness (default: 60)
  TMUX_SESSION_NAME  tmux session name used for the dev daemon (default: shadowbroker-dev)
EOF
}

RESET_LOG=0
while (($# > 0)); do
  case "$1" in
    --reset-log)
      RESET_LOG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[dev-daemon] Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

mkdir -p "$STATE_DIR"

if [[ $RESET_LOG -eq 1 ]]; then
  : > "$LOG_FILE"
fi

if [[ ! -f "$LOG_FILE" ]]; then
  touch "$LOG_FILE"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[dev-daemon] ERROR: npm not found in PATH."
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "[dev-daemon] ERROR: tmux not found in PATH."
  exit 1
fi

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

has_tmux_session() {
  local session_name="$1"
  tmux has-session -t "$session_name" 2>/dev/null
}

assert_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev-daemon] ERROR: port $port is already in use."
    lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
    exit 1
  fi
}

is_port_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    return 0
  fi
  return 1
}

wait_for_listener_ready() {
  local pid="$1"
  local port="$2"
  local timeout="$3"

  for _ in $(seq 1 "$timeout"); do
    if is_port_listening "$port"; then
      return 0
    fi
    if ! is_running "$pid"; then
      return 1
    fi
    sleep 1
  done
  return 1
}

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if has_tmux_session "$TMUX_SESSION_NAME"; then
    echo "[dev-daemon] Already running. PID=$EXISTING_PID"
    echo "[dev-daemon] Log file: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if has_tmux_session "$TMUX_SESSION_NAME"; then
  echo "[dev-daemon] Already running. Session=$TMUX_SESSION_NAME"
  echo "[dev-daemon] Log file: $LOG_FILE"
  exit 0
fi

assert_port_free "$FRONTEND_PORT"
assert_port_free "$BACKEND_PORT"

echo "[dev-daemon] Starting npm run dev in background..."
tmux new-session -d -s "$TMUX_SESSION_NAME" "cd \"$SCRIPT_DIR\" && exec npm run dev >> \"$LOG_FILE\" 2>&1"

sleep 3

NEW_PID="$(tmux list-panes -t "$TMUX_SESSION_NAME" -F '#{pane_pid}' 2>/dev/null | head -n 1 | tr -d '[:space:]')"
if [[ "$NEW_PID" =~ ^[0-9]+$ ]]; then
  echo "$NEW_PID" > "$PID_FILE"
fi
if ! has_tmux_session "$TMUX_SESSION_NAME" || [[ ! "$NEW_PID" =~ ^[0-9]+$ ]] || ! is_running "$NEW_PID"; then
  echo "[dev-daemon] ERROR: failed to start."
  echo "[dev-daemon] Last logs:"
  tail -n 60 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
fi

if ! wait_for_listener_ready "$NEW_PID" "$FRONTEND_PORT" "$START_TIMEOUT_SECONDS"; then
  echo "[dev-daemon] ERROR: frontend did not start listening on :$FRONTEND_PORT"
  echo "[dev-daemon] Last logs:"
  tail -n 80 "$LOG_FILE" || true
  if has_tmux_session "$TMUX_SESSION_NAME"; then
    tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  rm -f "$STARTED_AT_FILE"
  exit 1
fi

date '+%Y-%m-%d %H:%M:%S' > "$STARTED_AT_FILE"

echo "[dev-daemon] Started. PID=$NEW_PID"
echo "[dev-daemon] Session: $TMUX_SESSION_NAME"
echo "[dev-daemon] Dashboard: http://localhost:$FRONTEND_PORT"
echo "[dev-daemon] Note: the first page request may take time while Next.js compiles /."
echo "[dev-daemon] Logs: $LOG_FILE"
echo "[dev-daemon] Stop: ./dev-daemon-stop.sh"

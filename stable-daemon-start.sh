#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.stable-daemon"
PID_FILE="$STATE_DIR/app.pid"
LOG_FILE="$STATE_DIR/app.log"
STARTED_AT_FILE="$STATE_DIR/started_at"
FRONTEND_PORT="${FRONTEND_PORT:-6789}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-90}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-shadowbroker-stable}"
BUILD_BEFORE_START="${BUILD_BEFORE_START:-1}"

usage() {
  cat <<'EOF'
Usage:
  ./stable-daemon-start.sh [--reset-log]

Options:
  --reset-log   Truncate log file before starting
  -h, --help    Show this help

Environment:
  FRONTEND_PORT         Frontend port check/start target (default: 6789)
  BACKEND_PORT          Backend port check/start target (default: 8000)
  START_TIMEOUT_SECONDS Seconds to wait for frontend listener readiness (default: 90)
  TMUX_SESSION_NAME     tmux session name used for the stable daemon (default: shadowbroker-stable)
  BUILD_BEFORE_START    Build frontend before start (1/0, default: 1)
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
      echo "[stable-daemon] Unknown option: $1"
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
  echo "[stable-daemon] ERROR: npm not found in PATH."
  exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
  echo "[stable-daemon] ERROR: tmux not found in PATH."
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
    echo "[stable-daemon] ERROR: port $port is already in use."
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

ensure_frontend_deps() {
  if [[ -f "$SCRIPT_DIR/frontend/node_modules/next/package.json" ]]; then
    return
  fi
  echo "[stable-daemon] Installing frontend dependencies..."
  npm --prefix "$SCRIPT_DIR/frontend" install >> "$LOG_FILE" 2>&1
}

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if has_tmux_session "$TMUX_SESSION_NAME"; then
    echo "[stable-daemon] Already running. PID=$EXISTING_PID"
    echo "[stable-daemon] Log file: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if has_tmux_session "$TMUX_SESSION_NAME"; then
  echo "[stable-daemon] Already running. Session=$TMUX_SESSION_NAME"
  echo "[stable-daemon] Log file: $LOG_FILE"
  exit 0
fi

assert_port_free "$FRONTEND_PORT"
assert_port_free "$BACKEND_PORT"

ensure_frontend_deps

if [[ "$BUILD_BEFORE_START" == "1" || "$BUILD_BEFORE_START" == "true" ]]; then
  echo "[stable-daemon] Building frontend for stable mode..."
  npm --prefix "$SCRIPT_DIR/frontend" run build >> "$LOG_FILE" 2>&1
fi

echo "[stable-daemon] Starting stable frontend + backend in background..."
tmux new-session -d -s "$TMUX_SESSION_NAME" "cd \"$SCRIPT_DIR\" && node start-backend.js >> \"$LOG_FILE\" 2>&1 & exec npm --prefix frontend run start -- --hostname 0.0.0.0 --port \"$FRONTEND_PORT\" >> \"$LOG_FILE\" 2>&1"

sleep 3

NEW_PID="$(tmux list-panes -t "$TMUX_SESSION_NAME" -F '#{pane_pid}' 2>/dev/null | head -n 1 | tr -d '[:space:]')"
if [[ "$NEW_PID" =~ ^[0-9]+$ ]]; then
  echo "$NEW_PID" > "$PID_FILE"
fi
if ! has_tmux_session "$TMUX_SESSION_NAME" || [[ ! "$NEW_PID" =~ ^[0-9]+$ ]] || ! is_running "$NEW_PID"; then
  echo "[stable-daemon] ERROR: failed to start."
  echo "[stable-daemon] Last logs:"
  tail -n 80 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
fi

if ! wait_for_listener_ready "$NEW_PID" "$FRONTEND_PORT" "$START_TIMEOUT_SECONDS"; then
  echo "[stable-daemon] ERROR: frontend did not start listening on :$FRONTEND_PORT"
  echo "[stable-daemon] Last logs:"
  tail -n 120 "$LOG_FILE" || true
  if has_tmux_session "$TMUX_SESSION_NAME"; then
    tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  rm -f "$STARTED_AT_FILE"
  exit 1
fi

date '+%Y-%m-%d %H:%M:%S' > "$STARTED_AT_FILE"

echo "[stable-daemon] Started. PID=$NEW_PID"
echo "[stable-daemon] Session: $TMUX_SESSION_NAME"
echo "[stable-daemon] Dashboard: http://localhost:$FRONTEND_PORT"
echo "[stable-daemon] Logs: $LOG_FILE"
echo "[stable-daemon] Stop: ./stable-daemon-stop.sh"

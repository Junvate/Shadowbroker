#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.dev-daemon"
PID_FILE="$STATE_DIR/dev.pid"
LOG_FILE="$STATE_DIR/dev.log"
STARTED_AT_FILE="$STATE_DIR/started_at"
FRONTEND_PORT="${FRONTEND_PORT:-6789}"
BACKEND_PORT="${BACKEND_PORT:-8000}"

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

is_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

assert_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev-daemon] ERROR: port $port is already in use."
    lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
    exit 1
  fi
}

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
  if [[ "$EXISTING_PID" =~ ^[0-9]+$ ]] && is_running "$EXISTING_PID"; then
    echo "[dev-daemon] Already running. PID=$EXISTING_PID"
    echo "[dev-daemon] Log file: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

assert_port_free "$FRONTEND_PORT"
assert_port_free "$BACKEND_PORT"

echo "[dev-daemon] Starting npm run dev in background..."
(
  cd "$SCRIPT_DIR"
  nohup npm run dev >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
)

sleep 3

NEW_PID=""
if [[ -f "$PID_FILE" ]]; then
  NEW_PID="$(tr -d '[:space:]' < "$PID_FILE" || true)"
fi
if [[ ! "$NEW_PID" =~ ^[0-9]+$ ]] || ! is_running "$NEW_PID"; then
  echo "[dev-daemon] ERROR: failed to start."
  echo "[dev-daemon] Last logs:"
  tail -n 60 "$LOG_FILE" || true
  rm -f "$PID_FILE"
  exit 1
fi

date '+%Y-%m-%d %H:%M:%S' > "$STARTED_AT_FILE"

echo "[dev-daemon] Started. PID=$NEW_PID"
echo "[dev-daemon] Dashboard: http://localhost:$FRONTEND_PORT"
echo "[dev-daemon] Logs: $LOG_FILE"
echo "[dev-daemon] Stop: ./dev-daemon-stop.sh"

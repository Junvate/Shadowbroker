#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP_SCRIPT="$SCRIPT_DIR/dev-daemon-stop.sh"
START_SCRIPT="$SCRIPT_DIR/dev-daemon-start.sh"
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-1}"
PORT_GRACE_SECONDS="${PORT_GRACE_SECONDS:-3}"
FRONTEND_PORT="${FRONTEND_PORT:-6789}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
CLEANUP_PORTS_ON_RESTART="${CLEANUP_PORTS_ON_RESTART:-1}"

usage() {
  cat <<'EOF'
Usage:
  ./dev-daemon-restart.sh [start options]

Examples:
  ./dev-daemon-restart.sh
  ./dev-daemon-restart.sh --reset-log

Environment:
  RESTART_DELAY_SECONDS  Wait time between stop and start (default: 1)
  PORT_GRACE_SECONDS     Wait time after TERM before KILL on occupied ports (default: 3)
  CLEANUP_PORTS_ON_RESTART  Whether to cleanup stale listeners (1/0, default: 1)
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

list_listen_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
    return
  fi
}

cleanup_port() {
  local port="$1"
  local pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(list_listen_pids "$port")

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return
  fi

  echo "[dev-daemon] Found stale listener(s) on :$port -> ${pids[*]}"
  for pid in "${pids[@]}"; do
    if [[ "$pid" == "$$" ]]; then
      continue
    fi
    kill -TERM "$pid" 2>/dev/null || true
  done

  if [[ "$PORT_GRACE_SECONDS" =~ ^[0-9]+$ ]] && [[ "$PORT_GRACE_SECONDS" -gt 0 ]]; then
    sleep "$PORT_GRACE_SECONDS"
  fi

  local remain=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && remain+=("$pid")
  done < <(list_listen_pids "$port")

  if [[ "${#remain[@]}" -eq 0 ]]; then
    echo "[dev-daemon] Port :$port released."
    return
  fi

  echo "[dev-daemon] Force killing listener(s) on :$port -> ${remain[*]}"
  for pid in "${remain[@]}"; do
    if [[ "$pid" == "$$" ]]; then
      continue
    fi
    kill -KILL "$pid" 2>/dev/null || true
  done
}

echo "[dev-daemon] Restart: stopping..."
"$STOP_SCRIPT" || true

if [[ "$RESTART_DELAY_SECONDS" =~ ^[0-9]+$ ]] && [[ "$RESTART_DELAY_SECONDS" -gt 0 ]]; then
  sleep "$RESTART_DELAY_SECONDS"
fi

if [[ "$CLEANUP_PORTS_ON_RESTART" == "1" || "$CLEANUP_PORTS_ON_RESTART" == "true" ]]; then
  echo "[dev-daemon] Restart: cleaning stale listeners..."
  cleanup_port "$FRONTEND_PORT"
  cleanup_port "$BACKEND_PORT"
fi

echo "[dev-daemon] Restart: starting..."
"$START_SCRIPT" "$@"

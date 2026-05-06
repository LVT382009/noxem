#!/usr/bin/env bash
# Noxem Launcher — starts both servers, runs Hermes, cleans up on exit.
set -euo pipefail

NOXEM_DIR="$(cd "$(dirname "$0")" && pwd)"

# Config
MEMORY_PORT=${MEMORY_PORT:-3001}
GEMMA4_PORT=${GEMMA4_PORT:-8000}
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
GEMMA4_SERVER="$NOXEM_DIR/server/gemma4-server.mjs"
MEMORY_PID=""
GEMMA4_PID=""

# Color helpers
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

cleanup() {
  local code=$?
  echo ""
  dim "Shutting down Noxem servers..."
  [ -n "$MEMORY_PID" ] && kill "$MEMORY_PID" 2>/dev/null && dim "  Memory server stopped"
  [ -n "$GEMMA4_PID" ] && kill "$GEMMA4_PID" 2>/dev/null && dim "  Gemma 4 stopped"
  # Wait briefly for graceful shutdown
  wait "$MEMORY_PID" 2>/dev/null || true
  wait "$GEMMA4_PID" 2>/dev/null || true
  green "Noxem cleaned up."
  exit $code
}

wait_for_port() {
  local port=$1 name=$2 timeout=${3:-60}
  local elapsed=0
  printf "  Waiting for %s " "$name"
  while [ $elapsed -lt $timeout ]; do
    if command -v nc &>/dev/null; then
      nc -z 127.0.0.1 "$port" 2>/dev/null && { green "✓"; return 0; }
    else
      (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null && { green "✓"; return 0; }
    fi
    printf "."
    sleep 1
    elapsed=$((elapsed + 1))
  done
  red "✗ TIMEOUT"
  return 1
}

# ── Start servers ──
echo ""
green "╔═══════════════════════════════════╗"
green "║   Noxem — Starting Servers        ║"
green "╚═══════════════════════════════════╝"
echo ""

# 1. Memory server
echo "[1/2] Starting memory server..."
export MEMORY_PORT ENABLE_EMBEDDING=${ENABLE_EMBEDDING:-true} ENABLE_ADVISOR=${ENABLE_ADVISOR:-true} ENABLE_MAINTENANCE=${ENABLE_MAINTENANCE:-true}
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server"

# 2. Gemma 4 server
echo "[2/2] Starting Gemma 4 (this may take a while on first run)..."
export GEMMA4_PORT GEMMA4_DEVICE=${GEMMA4_DEVICE:-webgpu}
node "$GEMMA4_SERVER" &
GEMMA4_PID=$!
wait_for_port $GEMMA4_PORT "Gemma 4" 180  # longer timeout for model download

echo ""
green "Both servers ready!"
echo ""

# ── Trap cleanup ──
trap cleanup EXIT INT TERM

# ── Run Hermes ──
if [ $# -gt 0 ]; then
  # Forward arguments (e.g., "noxem-launcher.sh chat --model ...")
  green "Launching: hermes $*"
  hermes "$@"
else
  green "Launching: hermes chat"
  hermes chat
fi

echo ""
green "Hermes session ended."
#!/usr/bin/env bash
# Noxem Launcher — starts both servers, runs Hermes, cleans up on exit.
set -euo pipefail

NOXEM_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure Node.js is in PATH (handles WSL non-interactive shells)
if ! command -v node &>/dev/null && [ -d "$HOME/.local/bin" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Config
MEMORY_PORT=${MEMORY_PORT:-3001}
GEMMA4_PORT=${GEMMA4_PORT:-8000}
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
GEMMA4_SERVER="$NOXEM_DIR/server/gemma4-server.mjs"
MEMORY_PID=""
GEMMA4_PID=""

# OS detection
OS="$(uname -s)"

# Color helpers
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

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
  # Prevent double-run on INT/TERM + EXIT
  trap - EXIT
  exit $code
}

# Cross-platform port check: returns 0 if port is accepting connections
check_port() {
  local port=$1
  if command -v curl &>/dev/null; then
    curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:$port/" 2>/dev/null
  elif command -v nc &>/dev/null; then
    # macOS nc uses -G timeout, GNU nc uses -w timeout; try both
    nc -z -G 2 127.0.0.1 "$port" 2>/dev/null || nc -z -w 2 127.0.0.1 "$port" 2>/dev/null
  elif [ "$OS" != "Darwin" ] && (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    return 0
  else
    # Last resort: try a quick Node.js TCP connect
    node -e "
    require('net').createConnection($port, '127.0.0.1')
    .on('connect', () => process.exit(0))
    .on('error', () => process.exit(1))
    .setTimeout(2000, function() { process.exit(1); });
    " 2>/dev/null
  fi
}

wait_for_port() {
  local port=$1 name=$2 timeout=${3:-60}
  local elapsed=0
  printf "  Waiting for %s " "$name"
  while [ $elapsed -lt $timeout ]; do
    if check_port "$port"; then
      green "✓"
      return 0
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
green "║ Noxem — Starting Servers          ║"
green "╚═══════════════════════════════════╝"
echo ""

# 1. Memory server
echo "[1/2] Starting memory server..."
dim "  First run downloads EmbeddingGemma (~300MB)"
export MEMORY_PORT
export ENABLE_EMBEDDING=${ENABLE_EMBEDDING:-true}
export ENABLE_ADVISOR=${ENABLE_ADVISOR:-true}
export ENABLE_MAINTENANCE=${ENABLE_MAINTENANCE:-true}
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server" 180

# 2. Gemma 4 server
echo "[2/2] Starting Gemma 4 server..."
dim "  First run downloads model (~2GB, subsequent starts use cache)"
# Device is auto-detected in gemma4-server.mjs:
# - Node.js: onnxruntime-node picks best EP (CUDA > DirectML > CPU)
# - GEMMA4_DEVICE env var overrides auto-detection
# - WebGPU is browser-only, not available in Node.js
export GEMMA4_PORT
node "$GEMMA4_SERVER" &
GEMMA4_PID=$!
wait_for_port $GEMMA4_PORT "Gemma 4" 300

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

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
LLM_PORT=${LLM_PORT:-${GEMMA4_PORT:-8000}}
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
LLM_SERVER="$NOXEM_DIR/server/gemma4-server.mjs"
MEMORY_PID=""
LLM_PID=""

# OS detection
OS="$(uname -s)"

# Color helpers (must be defined before use)
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

# HuggingFace mirror — WSL/China users may need this to download models
# If HF_ENDPOINT is not set and we're in WSL, default to hf-mirror.com
if [ -z "${HF_ENDPOINT:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  export HF_ENDPOINT="https://hf-mirror.com/"
  dim " WSL detected: using hf-mirror.com for model downloads"
fi

cleanup() {
  local code=$?
  echo ""
  dim "Shutting down Noxem servers..."
  # Send SIGTERM to allow graceful shutdown (flushes model cache writes)
  [ -n "$MEMORY_PID" ] && kill "$MEMORY_PID" 2>/dev/null && dim " Memory server stopping..."
  [ -n "$LLM_PID" ] && kill "$LLM_PID" 2>/dev/null && dim " LLM stopping..."
  # Wait up to 8s for servers to flush model cache to disk
  # This prevents cache corruption that causes "fetch failed" on next startup
  local waited=0
  while [ $waited -lt 8 ]; do
    if ! kill -0 "$MEMORY_PID" 2>/dev/null && ! kill -0 "$LLM_PID" 2>/dev/null; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # Force kill if still running
  kill -9 "$MEMORY_PID" 2>/dev/null || true
  kill -9 "$LLM_PID" 2>/dev/null || true
  wait "$MEMORY_PID" 2>/dev/null || true
  wait "$LLM_PID" 2>/dev/null || true
  dim " Memory server stopped"
  dim " LLM stopped"
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
# cd into NOXEM_DIR so relative cache paths (./.cache/) resolve correctly
cd "$NOXEM_DIR"
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
# Prefer IPv4 for HuggingFace CDN downloads (WSL IPv6 can cause ConnectTimeoutError)
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server" 180

# 2. LLM server
echo "[2/2] Starting LLM server..."
dim "  First run downloads model (~2GB, subsequent starts use cache)"
# Device is auto-detected in gemma4-server.mjs:
# - Node.js: onnxruntime-node picks best EP (CUDA > DirectML > CPU)
# - LLM_DEVICE / GEMMA4_DEVICE env var overrides auto-detection
# - WebGPU is browser-only, not available in Node.js
export LLM_PORT
node "$LLM_SERVER" &
LLM_PID=$!
wait_for_port $LLM_PORT "LLM" 300

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

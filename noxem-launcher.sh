#!/usr/bin/env bash
# Noxem Launcher — starts both servers, runs Hermes, cleans up on exit.
set -euo pipefail

NOXEM_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure Node.js is in PATH (handles WSL non-interactive shells)
if ! command -v node &>/dev/null && [ -d "$HOME/.local/bin" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# ── Check: noxem must be set as memory provider ──
HERMES_CONFIG="${HOME}/.hermes/config.yaml"
if [ -f "$HERMES_CONFIG" ]; then
    # Check if "provider: noxem" exists anywhere in config (handles both flat and nested YAML)
    if ! grep -q 'provider:.*noxem' "$HERMES_CONFIG"; then
        echo ""
        echo "Error: Noxem is not set as your memory provider."
        echo ""
        echo "Please run:  hermes memory setup"
        echo "And select 'noxem' as your memory provider."
        echo ""
        exit 1
    fi
else
    echo ""
    echo "Error: Hermes config not found at $HERMES_CONFIG"
    echo ""
    echo "Please run:  hermes memory setup"
    echo "And select 'noxem' as your memory provider."
    echo ""
    exit 1
fi
# Config
MEMORY_PORT=${MEMORY_PORT:-3001}
LLM_PORT=${LLM_PORT:-${GEMMA4_PORT:-8000}}
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
LLM_SERVER="$NOXEM_DIR/server/gemma4-server.mjs"
MEMORY_PID=""
LLM_PID=""

# Brain 2 — optional, controlled by flag or interactive prompt
BRAIN2_ENABLED=""  # unset = ask; 1 = on; 0 = off
for _arg in "$@"; do
  case "$_arg" in
    --brain2)   BRAIN2_ENABLED=1; shift ;; 
    --no-brain2) BRAIN2_ENABLED=0; shift ;;
  esac
done

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
  dim " WSL detected: using hf-mirror.com for downloads"
fi

cleanup() {
  local code=$?
  echo ""
  dim "Shutting down Noxem servers..."
  # Send SIGTERM to allow graceful shutdown (flushes model cache writes)
  if [ -n "$MEMORY_PID" ]; then
    kill "$MEMORY_PID" 2>/dev/null && dim " Memory server stopping..." || true
  fi
  if [ -n "$LLM_PID" ] && [ "$BRAIN2_ENABLED" = "1" ]; then
    kill "$LLM_PID" 2>/dev/null && dim " Brain 2 stopping..." || true
  fi
  # Wait up to 8s for servers to flush model cache to disk
  # This prevents cache corruption that causes "fetch failed" on next startup
  local waited=0
  while [ $waited -lt 8 ]; do
    mem_alive=false
    llm_alive=false
    kill -0 "$MEMORY_PID" 2>/dev/null && mem_alive=true
    if [ "$BRAIN2_ENABLED" = "1" ]; then
      kill -0 "$LLM_PID" 2>/dev/null && llm_alive=true
    fi
    if [ "$mem_alive" = "false" ] && [ "$llm_alive" = "false" ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  # Force kill if still running
  kill -9 "$MEMORY_PID" 2>/dev/null || true
  if [ "$BRAIN2_ENABLED" = "1" ]; then
    kill -9 "$LLM_PID" 2>/dev/null || true
    wait "$LLM_PID" 2>/dev/null || true
    dim " Brain 2 stopped"
  fi
  wait "$MEMORY_PID" 2>/dev/null || true
  dim " Memory server stopped"
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
        node -e 'var p=process.argv[1];var c=require("net").createConnection(p,"127.0.0.1");c.on("connect",function(){process.exit(0)});c.on("error",function(){process.exit(1)});c.setTimeout(2e3,function(){process.exit(1)})' "$port" 2>/dev/null
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

# ── Brain 2 selection ──
if [ -z "$BRAIN2_ENABLED" ]; then
  if [ ! -t 0 ]; then
    # Non-interactive (piped input, cron, etc.) — default: Brain 2 off
    BRAIN2_ENABLED=0
  else
    echo ""
    green '╔═══════════════════════════════════╗'
    green '║ Noxem — Brain Selection           ║'
    green '╚═══════════════════════════════════╝'
    echo ""
    echo 'Enable Brain 2 (Recommended for users with high RAM) for this session?'
    echo ""
    echo '  [1] Yes  — full memory + advisor + research + extraction'
    echo '  [2] No   — memory search only (faster startup, less RAM)'
    echo '  [3] Quit'
    echo ""
    read -rp 'Choose [1-3]: ' _brain_choice
    case "$_brain_choice" in
      1) BRAIN2_ENABLED=1 ;;
      2) BRAIN2_ENABLED=0 ;;
      3) exit 0 ;;
      *) BRAIN2_ENABLED=0 ;;
    esac
  fi
fi
export BRAIN2_ENABLED

echo ""
if [ "$BRAIN2_ENABLED" = '1' ]; then
  green '╔═══════════════════════════════════╗'
  green '║ Noxem — Starting Servers          ║'
  green '╚═══════════════════════════════════╝'
else
  green '╔═══════════════════════════════════╗'
  green '║ Noxem — Brain 1 Only             ║'
  green '╚═══════════════════════════════════╝'
fi
echo ""

# 1. Memory server
echo "[1/2] Starting memory server..."
dim " Install Brain-1 AI (~300MB, first run)"
export MEMORY_PORT
export ENABLE_EMBEDDING=${ENABLE_EMBEDDING:-true}
export ENABLE_ADVISOR=${ENABLE_ADVISOR:-true}
export ENABLE_MAINTENANCE=${ENABLE_MAINTENANCE:-true}
# Suppress [INFO] request logs in TUI — only show WARN/ERROR
export LOG_LEVEL=${LOG_LEVEL:-quiet}
# Pass Brain 2 mode to memory server so it can disable advisor/research
export BRAIN2_ENABLED
# Prefer IPv4 for HuggingFace CDN downloads (WSL IPv6 can cause ConnectTimeoutError)
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server" 180

# 2. LLM server (Brain 2 — optional)
if [ "$BRAIN2_ENABLED" = '1' ]; then
  echo "[2/2] Starting Brain 2..."
  dim " First run downloads model (~2GB, subsequent starts use cache)"
  # Device is auto-detected in gemma4-server.mjs:
  # - Node.js: onnxruntime-node picks best EP (CUDA > DirectML > CPU)
  # - LLM_DEVICE / GEMMA4_DEVICE env var overrides auto-detection
  # - WebGPU is browser-only, not available in Node.js
  export LLM_PORT
  node "$LLM_SERVER" &
  LLM_PID=$!
  wait_for_port $LLM_PORT "LLM" 300

  echo ""
  green 'Both servers ready!'
  echo ''
else
  echo "[2/2] Brain 2 — skipped"
  echo ''
  green 'Memory server ready! (Brain 1 only)'
  echo ''
fi

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
if [ "$BRAIN2_ENABLED" = "1" ]; then
  green "Hermes session ended. (Both brains were active)"
else
  green "Hermes session ended. (Brain 1 only)"
fi

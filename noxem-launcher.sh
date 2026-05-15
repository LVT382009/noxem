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
    echo "Please run: hermes memory setup"
    echo "And select 'noxem' as your memory provider."
    echo ""
    exit 1
  fi
else
  echo ""
  echo "Error: Hermes config not found at $HERMES_CONFIG"
  echo ""
  echo "Please run: hermes memory setup"
  echo "And select 'noxem' as your memory provider."
  echo ""
  exit 1
fi

# Config
MEMORY_PORT=${MEMORY_PORT:-3001}
LLM_PORT=${LLM_PORT:-${GEMMA4_PORT:-8000}}
QWENPROXY_PORT=${QWENPROXY_PORT:-3000}
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
ADAPTER_SERVER="$NOXEM_DIR/server/qwenproxy-adapter.mjs"
QWENPROXY_DIR="${HOME}/qwenproxy"
QWENPROXY_ENV="$QWENPROXY_DIR/.env"
MEMORY_PID=""
ADAPTER_PID=""
QWENPROXY_PID=""

# Brain 2 — optional, controlled by flag or interactive prompt
BRAIN2_ENABLED="" # unset = ask; 1 = on; 0 = off
for _arg in "$@"; do
  case "$_arg" in
    --brain2) BRAIN2_ENABLED=1; shift ;;
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
if [ -z "${HF_ENDPOINT:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  export HF_ENDPOINT="https://hf-mirror.com/"
  dim " WSL detected: using hf-mirror.com for downloads"
fi

# ── Prompt for Qwen credentials (email + password) ──
prompt_qwen_credentials() {
  # Check if .env already has credentials
  if [ -f "$QWENPROXY_ENV" ] && grep -q '^QWEN_EMAIL=' "$QWENPROXY_ENV" && grep -q '^QWEN_PASSWORD=' "$QWENPROXY_ENV"; then
    dim " QwenProxy credentials found in $QWENPROXY_ENV"
    return 0
  fi

  echo ""
  green '╔══════════════════════════════════════════════╗'
  green '║ DeepSeek Login Required                        ║'
  green '╚══════════════════════════════════════════════╝'
  echo ""
  echo "QwenProxy needs your Qwen account credentials for automated login."
  echo "These will be saved to $QWENPROXY_ENV"
  echo ""

  read -rp 'Qwen Email: ' _qwen_email
  read -rsp 'Qwen Password: ' _qwen_password
  echo ""

  if [ -z "$_qwen_email" ] || [ -z "$_qwen_password" ]; then
    red " Email and password are required."
    return 1
  fi

  # Write .env file
  mkdir -p "$QWENPROXY_DIR"
  cat > "$QWENPROXY_ENV" <<ENVEOF
PORT=${QWENPROXY_PORT}
QWEN_EMAIL=${_qwen_email}
QWEN_PASSWORD=${_qwen_password}
ENVEOF
  chmod 600 "$QWENPROXY_ENV"
  green " Credentials saved to $QWENPROXY_ENV"
}

# ── Setup QwenProxy (clone + install + Playwright) ──
setup_qwenproxy() {
  if [ ! -d "$QWENPROXY_DIR/node_modules" ]; then
    echo ""
    dim " Setting up QwenProxy (first run)..."

    # Clone if not present
    if [ ! -d "$QWENPROXY_DIR/.git" ]; then
      dim " Cloning qwenproxy..."
      git clone https://github.com/pedrofariasx/qwenproxy.git "$QWENPROXY_DIR" 2>/dev/null || {
        red " Failed to clone QwenProxy. Check your internet connection."
        return 1
      }
    fi

    # Install dependencies
    dim " Installing npm dependencies..."
    (cd "$QWENPROXY_DIR" && npm install --silent 2>/dev/null) || {
      red " npm install failed."
      return 1
    }

    # Install Playwright browsers — skip if Hermes already cached Chromium
    if ls "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux64/chrome 2>/dev/null | head -1 | grep -q .; then
      dim " Playwright Chromium already cached (from Hermes) — skipping download"
    else
      dim " Installing Playwright browsers..."
      (cd "$QWENPROXY_DIR" && npx playwright install chromium 2>/dev/null) || {
        red " Playwright browser install failed."
        dim " Try manually: cd $QWENPROXY_DIR && npx playwright install chromium"
        return 1
      }
    fi

    green " QwenProxy setup complete!"
  fi

  # Prompt for credentials if needed
  prompt_qwen_credentials || return 1
}

cleanup() {
  local code=$?
  echo ""
  dim "Shutting down Noxem servers..."
  if [ -n "$MEMORY_PID" ]; then
    kill "$MEMORY_PID" 2>/dev/null && dim " Memory server stopping..." || true
  fi
  if [ "$BRAIN2_ENABLED" = "1" ]; then
    if [ -n "$ADAPTER_PID" ]; then
      kill "$ADAPTER_PID" 2>/dev/null && dim " QwenProxy adapter stopping..." || true
    fi
    if [ -n "$QWENPROXY_PID" ]; then
      kill "$QWENPROXY_PID" 2>/dev/null && dim " QwenProxy stopping..." || true
    fi
  fi
  # Wait up to 8s for graceful shutdown
  local waited=0
  while [ $waited -lt 8 ]; do
    mem_alive=false; adapter_alive=false; qp_alive=false
    kill -0 "$MEMORY_PID" 2>/dev/null && mem_alive=true
    if [ "$BRAIN2_ENABLED" = "1" ]; then
      kill -0 "$ADAPTER_PID" 2>/dev/null && adapter_alive=true
      kill -0 "$QWENPROXY_PID" 2>/dev/null && qp_alive=true
    fi
    [ "$mem_alive" = "false" ] && [ "$adapter_alive" = "false" ] && [ "$qp_alive" = "false" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$MEMORY_PID" 2>/dev/null || true
  if [ "$BRAIN2_ENABLED" = "1" ]; then
    kill -9 "$ADAPTER_PID" 2>/dev/null || true
    wait "$ADAPTER_PID" 2>/dev/null || true
    kill -9 "$QWENPROXY_PID" 2>/dev/null || true
    wait "$QWENPROXY_PID" 2>/dev/null || true
    dim " Brain 2 stopped"
  fi
  wait "$MEMORY_PID" 2>/dev/null || true
  dim " Memory server stopped"
  green "Noxem cleaned up."
  trap - EXIT
  exit $code
}

# Cross-platform port check
check_port() {
  local port=$1
  if command -v curl &>/dev/null; then
    curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:$port/" 2>/dev/null
  elif command -v nc &>/dev/null; then
    nc -z -G 2 127.0.0.1 "$port" 2>/dev/null || nc -z -w 2 127.0.0.1 "$port" 2>/dev/null
  elif [ "$OS" != "Darwin" ] && (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    return 0
  else
    node -e 'var p=process.argv[1];var c=require("net").createConnection(p,"127.0.0.1");c.on("connect",function(){process.exit(0)});c.on("error",function(){process.exit(1)});c.setTimeout(2e3,function(){process.exit(1)})' "$port" 2>/dev/null
  fi
}

wait_for_port() {
  local port=$1 name=$2 timeout=${3:-60}
  local elapsed=0
  printf " Waiting for %s " "$name"
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
cd "$NOXEM_DIR"

# ── Brain 2 selection ──
if [ -z "$BRAIN2_ENABLED" ]; then
  if [ ! -t 0 ]; then
    BRAIN2_ENABLED=0
  else
    echo ""
    green '╔═══════════════════════════════════╗'
    green '║ Noxem — Brain Selection           ║'
    green '╚═══════════════════════════════════╝'
    echo ""
    echo 'Enable Brain 2 (Qwen3.6-plus via QwenProxy — requires separate setup) for this session?'
    echo ""
    echo ' [1] Yes — full memory + advisor + research + extraction'
    echo ' [2] No — memory search only (faster startup, less RAM)'
    echo ' [3] Quit'
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
export LOG_LEVEL=${LOG_LEVEL:-quiet}
export BRAIN2_ENABLED
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server" 180

# 2. Brain 2 — QwenProxy + adapter (optional)
if [ "$BRAIN2_ENABLED" = '1' ]; then
  echo "[2/2] Starting Brain 2 (QwenProxy)..."

  # Setup QwenProxy (clone, install, Playwright, credentials)
  if ! setup_qwenproxy; then
    red " QwenProxy setup failed — continuing without Brain 2"
    BRAIN2_ENABLED=0
    export BRAIN2_ENABLED
  else
    # Start QwenProxy server (it auto-logs in with credentials from .env)
  # Kill any leftover process on QwenProxy port from a previous session
  if check_port $QWENPROXY_PORT; then
    dim " Port $QWENPROXY_PORT in use -- killing existing process..."
    fuser -k $QWENPROXY_PORT/tcp 2>/dev/null || true
    # Wait for port to actually free up
    _kill_wait=0
    while check_port $QWENPROXY_PORT && [ $_kill_wait -lt 15 ]; do
      fuser -k $QWENPROXY_PORT/tcp 2>/dev/null || true
      sleep 1
      _kill_wait=$((_kill_wait + 1))
    done
  fi
  dim " Starting QwenProxy server..."
  (cd "$QWENPROXY_DIR" && npm start >/dev/null 2>&1) &
  QWENPROXY_PID=$!
  wait_for_port $QWENPROXY_PORT "QwenProxy" 120

    # Start the SSE-to-JSON adapter on the traditional LLM port
    dim " Starting QwenProxy adapter..."
    export QWENPROXY_URL="http://127.0.0.1:${QWENPROXY_PORT}"
    node "$ADAPTER_SERVER" &
    ADAPTER_PID=$!
    wait_for_port $LLM_PORT "Adapter" 15

    echo ""
    green 'Both servers ready!'
    echo '  Memory server  → http://127.0.0.1:'$MEMORY_PORT
    echo '  QwenProxy      → http://127.0.0.1:'$QWENPROXY_PORT
    echo '  Adapter (LLM)  → http://127.0.0.1:'$LLM_PORT
    echo ''
  fi
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

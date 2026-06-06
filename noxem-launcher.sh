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
# QwenProxy dir — override with QWENPROXY_DIR env var
MEMORY_SERVER="$NOXEM_DIR/server/memory-server.mjs"
ADAPTER_SERVER="$NOXEM_DIR/server/qwenproxy-adapter.mjs"
QWENPROXY_DIR="${QWENPROXY_DIR:-$NOXEM_DIR/qwen-proxy}"
QWENPROXY_ENV="$QWENPROXY_DIR/.env"
NOXEM_CONFIG="${HOME}/.hermes/noxem.json"
MEMORY_PID=""
ADAPTER_PID=""
QWENPROXY_PID=""

# Brain 2 — controlled by flag or interactive prompt
BRAIN2_ENABLED=""   # unset = ask; 1 = on; 0 = off
BRAIN2_PROVIDER=""  # unset = ask; qwenproxy = cloud; local = any OpenAI-compatible

for _arg in "$@"; do
  case "$_arg" in
    --brain2) BRAIN2_ENABLED=1; shift ;;
    --no-brain2) BRAIN2_ENABLED=0; shift ;;
    --qwenproxy) BRAIN2_ENABLED=1; BRAIN2_PROVIDER=qwenproxy; shift ;;
    --local) BRAIN2_ENABLED=1; BRAIN2_PROVIDER=local; shift ;;
      --freellm) BRAIN2_ENABLED=1; BRAIN2_PROVIDER=freellm; shift ;;
  esac
done

# OS detection
OS="$(uname -s)"

# Ubuntu version check — Brain 2 QwenProxy not supported on 26.04+
check_ubuntu_brain2() {
  return 0
}

# Color helpers (must be defined before use)
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

# HuggingFace mirror — WSL/China users may need this to download models
if [ -z "${HF_ENDPOINT:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  export HF_ENDPOINT="https://hf-mirror.com/"
  dim " WSL detected: using hf-mirror.com for downloads"
fi

# ── Read saved config from noxem.json ─────────────────────────
read_noxem_config() {
  if [ -f "$NOXEM_CONFIG" ]; then
    # Simple JSON parse with grep/sed (no jq dependency)
    _cfg_provider=$(grep -o '"brain2_provider"[[:space:]]*:[[:space:]]*"[^"]*"' "$NOXEM_CONFIG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    _cfg_llm_url=$(grep -o '"llm_url"[[:space:]]*:[[:space:]]*"[^"]*"' "$NOXEM_CONFIG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    _cfg_llm_model=$(grep -o '"llm_model"[[:space:]]*:[[:space:]]*"[^"]*"' "$NOXEM_CONFIG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    _cfg_llm_api_key=$(grep -o '"llm_api_key"[[:space:]]*:[[:space:]]*"[^"]*"' "$NOXEM_CONFIG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    _cfg_memory_server=$(grep -o '"memory_server"[[:space:]]*:[[:space:]]*"[^"]*"' "$NOXEM_CONFIG" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")

    # Apply saved config to env vars (env vars take precedence if already set)
    if [ -n "$_cfg_provider" ] && [ -z "$BRAIN2_PROVIDER" ]; then
      BRAIN2_PROVIDER="$_cfg_provider"
    fi
    if [ -n "$_cfg_llm_url" ] && [ -z "${LLM_URL:-}" ]; then
      export LLM_URL="$_cfg_llm_url"
    fi
    if [ -n "$_cfg_llm_model" ] && [ -z "${LLM_MODEL:-}" ]; then
      export LLM_MODEL="$_cfg_llm_model"
    fi
    if [ -n "$_cfg_llm_api_key" ] && [ -z "${LLM_API_KEY:-}" ]; then
      export LLM_API_KEY="$_cfg_llm_api_key"
    fi
    if [ -n "$_cfg_memory_server" ] && [ -z "${NOXEM_SERVER:-}" ]; then
      export NOXEM_SERVER="$_cfg_memory_server"
      # Extract port from URL for memory server
      MEMORY_PORT=$(echo "$_cfg_memory_server" | grep -oE '[0-9]+$' || echo "$MEMORY_PORT")
		fi
	fi
}
if [ -z "${LLM_API_KEY:-}" ]; then
	_env_file="${HOME}/.hermes/.env"
	if [ -f "$_env_file" ]; then
  _resolved_key=$(grep '^LLM_API_KEY=' "$_env_file" 2>/dev/null | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
		if [ -n "$_resolved_key" ]; then
			export LLM_API_KEY="$_resolved_key"
		fi
	fi
fi

# ── Prompt for Qwen credentials (email + password) ──
prompt_qwen_credentials() {
  # Check if .env already has ACCOUNTS
  if [ -f "$QWENPROXY_ENV" ] && grep -q '^ACCOUNTS=' "$QWENPROXY_ENV"; then
    dim " QwenProxy credentials found in $QWENPROXY_ENV"
    if ! grep -q "^SERVICE_PORT=" "$QWENPROXY_ENV"; then
      echo "SERVICE_PORT=${QWENPROXY_PORT}" >> "$QWENPROXY_ENV"
    else
      sed -i "s/^SERVICE_PORT=.*/SERVICE_PORT=${QWENPROXY_PORT}/" "$QWENPROXY_ENV"
    fi
    return 0
  fi

  echo ""
  green '╔══════════════════════════════════════════════╗'
  green '║     Qwen Account Login Required             ║'
  green '╚══════════════════════════════════════════════╝'
  echo ""
  echo "QwenProxy needs your Qwen account credentials."
  echo "These will be saved to $QWENPROXY_ENV"
  echo ""

  read -rp 'Qwen Email: ' _qwen_email
  read -rsp 'Qwen Password: ' _qwen_password
  echo ""

  if [ -z "$_qwen_email" ] || [ -z "$_qwen_password" ]; then
    red " Email and password are required."
    return 1
  fi

  # Write .env file (ACCOUNTS format: email:password)
  mkdir -p "$QWENPROXY_DIR"
  cat > "$QWENPROXY_ENV" <<ENVEOF
SERVICE_PORT=${QWENPROXY_PORT}
ACCOUNTS=${_qwen_email}:${_qwen_password}
OUTPUT_THINK=true
LOG_LEVEL=INFO
ENVEOF
  chmod 600 "$QWENPROXY_ENV"
  green " Credentials saved to $QWENPROXY_ENV"
}
# ── Prompt for local LLM settings ──
prompt_local_llm() {
  echo ""
  green '╔══════════════════════════════════════════════╗'
  green '║ Local LLM Configuration                     ║'
  green '╚══════════════════════════════════════════════╝'
  echo ""
  echo "Enter your local LLM endpoint details."
  echo "Supported: Ollama, LM Studio, llama.cpp, any OpenAI-compatible API"
  echo ""
  echo " Common base URLs:"
  echo "   Ollama:     http://localhost:11434/v1"
  echo "   LM Studio:  http://localhost:1234/v1"
  echo "   llama.cpp:  http://127.0.0.1:8080/v1"
  echo ""

  # Base URL
  local _default_url="${LLM_URL:-http://localhost:11434/v1}"
  read -rp "Base URL [${_default_url}]: " _local_url
  _local_url="${_local_url:-$_default_url}"

  # Model name
  local _default_model="${LLM_MODEL:-}"
  if [ -z "$_default_model" ]; then
    # Try to detect from Ollama
    if command -v ollama &>/dev/null; then
      local _first_model
      _first_model=$(ollama list 2>/dev/null | head -3 | tail -1 | awk '{print $1}' || echo "")
      if [ -n "$_first_model" ]; then
        _default_model="$_first_model"
        dim " Detected Ollama model: $_default_model"
      fi
    fi
  fi
  read -rp "Model name [${_default_model:-gemma4:e4b}]: " _local_model
  _local_model="${_local_model:-${_default_model:-gemma4:e4b}}"

  # API key (optional)
  echo ""
  dim " API key is optional — not needed for Ollama or llama.cpp"
  read -rp "API key (press Enter to skip): " _local_api_key

  # Export for adapter and server processes
  export LLM_URL="${_local_url}/chat/completions"
  export LOCAL_LLM_URL="$_local_url"
  export LLM_MODEL="$_local_model"
  export BRAIN2_PROVIDER="local"
  if [ -n "$_local_api_key" ]; then
    export LLM_API_KEY="$_local_api_key"
  fi

  green " Local LLM configured: $_local_url model=$_local_model"
}

# ── Prompt for FreeLLM (FreeTheAI.xyz) settings ──
prompt_freellm() {
    echo ""
    green '╔══════════════════════════════════════════════╗'
    green '║ FreeLLM — FreeTheAI.xyz Free API            ║'
    green '╚══════════════════════════════════════════════╝'
    echo ""
    echo " Get free LLM access from FreeTheAI.xyz:"
    echo ""
    echo "   1. Join the Discord: https://discord.gg/hnz3yB3bWg"
    echo "   2. Go to #how-to-signup channel to get your API key"
    echo "   3. Go to #how-to-checkin channel to activate your key"
    echo "   4. Browse models at: https://freetheai.xyz/models/"
    echo "   5. Check model status at: https://freetheai.xyz/status/"
    echo ""
    dim " Base URL: https://api.freetheai.xyz/v1 (fixed)"
    echo ""

    # API key (required)
    read -rp "API key: " _freellm_api_key
    if [ -z "$_freellm_api_key" ]; then
        red " API key is required for FreeTheAI.xyz"
        echo " Get one at: https://discord.gg/hnz3yB3bWg -> #how-to-signup"
        return 1
    fi

    # Model name
    echo ""
    echo " Browse available models: https://freetheai.xyz/models/"
    echo " Check model status: https://freetheai.xyz/status/"
    read -rp "Model ID (e.g. fee/kimi-k2.6): " _freellm_model
    if [ -z "$_freellm_model" ]; then
        _freellm_model="fee/kimi-k2.6"
        dim " Using default: $_freellm_model"
    fi

    # Context window
    read -rp "Context window in tokens [131072]: " _freellm_ctx
    _freellm_ctx="${_freellm_ctx:-131072}"

    # Export — FreeLLM uses local passthrough mode with fixed URL
    export LLM_URL="https://api.freetheai.xyz/v1/chat/completions"
    export LOCAL_LLM_URL="https://api.freetheai.xyz/v1"
    export LLM_MODEL="$_freellm_model"
    export LLM_API_KEY="$_freellm_api_key"
    export NOXEM_CONTEXT_WINDOW="$_freellm_ctx"
    export BRAIN2_PROVIDER="local"

    green " FreeLLM configured: freetheai.xyz model=$_freellm_model context=${_freellm_ctx}"
}


# ── Setup QwenProxy (npm install, no Playwright) ──
setup_qwenproxy() {
  if [ ! -d "$QWENPROXY_DIR" ]; then
    red " QwenProxy directory not found: $QWENPROXY_DIR"
    dim " Set QWENPROXY_DIR to the Qwen-Proxy directory, or clone it to ~/qwen-proxy"
    return 1
  fi

  if [ ! -d "$QWENPROXY_DIR/node_modules" ]; then
    echo ""
    dim " Setting up QwenProxy (first run)..."
    dim " Installing npm dependencies..."
    (cd "$QWENPROXY_DIR" && npm install --silent 2>/dev/null) || {
      red " npm install failed."
      return 1
    }
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
  if [ -n "$TURBOVEC_PID" ]; then
    kill "$TURBOVEC_PID" 2>/dev/null && dim " TurboVec stopping..." || true
  fi
  if [ "$BRAIN2_ENABLED" = "1" ]; then
    if [ -n "$ADAPTER_PID" ]; then
      kill "$ADAPTER_PID" 2>/dev/null && dim " LLM adapter stopping..." || true
    fi
    if [ "$BRAIN2_PROVIDER" = "qwenproxy" ] && [ -n "$QWENPROXY_PID" ]; then
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
      if [ "$BRAIN2_PROVIDER" = "qwenproxy" ]; then
        kill -0 "$QWENPROXY_PID" 2>/dev/null && qp_alive=true
      fi
    fi
    [ "$mem_alive" = "false" ] && [ "$adapter_alive" = "false" ] && [ "$qp_alive" = "false" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$MEMORY_PID" 2>/dev/null || true
  if [ "$BRAIN2_ENABLED" = "1" ]; then
    kill -9 "$ADAPTER_PID" 2>/dev/null || true
    wait "$ADAPTER_PID" 2>/dev/null || true
    if [ "$BRAIN2_PROVIDER" = "qwenproxy" ]; then
      kill -9 "$QWENPROXY_PID" 2>/dev/null || true
      wait "$QWENPROXY_PID" 2>/dev/null || true
    fi
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
      green "OK"
      return 0
    fi
    printf "."
    sleep 1
    elapsed=$((elapsed + 1))
  done
  red "TIMEOUT"
  return 1
}

# ── Start servers ──
cd "$NOXEM_DIR"
# ── Kill stale processes from previous session ──
kill_stale_port() {
  local port=$1
  if check_port "$port"; then
    dim "  Port $port in use — killing stale process..."
    fuser -k "$port"/tcp 2>/dev/null || true
    local _kw=0
    while check_port "$port" && [ $_kw -lt 10 ]; do
      fuser -k "$port"/tcp 2>/dev/null || true
      sleep 1
      _kw=$((_kw + 1))
    done
    if check_port "$port"; then
      red "  Port $port still occupied after 10s — another app may be using it"
    fi
  fi
}

kill_stale_port $MEMORY_PORT
kill_stale_port ${TURBOVEC_PORT:-3003}
kill_stale_port $LLM_PORT
kill_stale_port $QWENPROXY_PORT



# Read saved config first (env vars/cli flags take precedence)
read_noxem_config

# Fallback: secret fields save to .env, not noxem.json
if [ -z "${LLM_API_KEY:-}" ]; then
	_env_file="${HOME}/.hermes/.env"
	if [ -f "$_env_file" ]; then
		_resolved_key=$(grep '^LLM_API_KEY=' "$_env_file" 2>/dev/null | head -1 | cut -d= -f2- | sed "s/^['\"]//;s/['\"]$//")
		if [ -n "$_resolved_key" ]; then
			export LLM_API_KEY="$_resolved_key"
		fi
	fi
fi

# FreeLLM preset: set fixed URL
if [ "$BRAIN2_PROVIDER" = 'freellm' ]; then
	export LLM_URL="https://api.freetheai.xyz/v1/chat/completions"
	export LOCAL_LLM_URL="https://api.freetheai.xyz/v1"
	export BRAIN2_PROVIDER=freellm  # keep as freellm for display, treated as local for adapter
fi

# ── Brain 1 + Brain 2 selection ──
if [ -z "$BRAIN2_ENABLED" ]; then
  if [ ! -t 0 ]; then
    BRAIN2_ENABLED=0
  else
    echo ""
    green '╔═══════════════════════════════════╗'
    green '║ Noxem — Brain Selection           ║'
    green '╚═══════════════════════════════════╝'
    echo ""
    echo ' [1] Brain 1 + Brain 2 — full memory + advisor + research + extraction'
    echo ' [2] Brain 1 only — memory search only (faster startup, less RAM)'
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

# ── Brain 2 provider selection (only if Brain 2 enabled and not already set) ──
if [ "$BRAIN2_ENABLED" = '1' ] && [ -z "$BRAIN2_PROVIDER" ]; then
  if [ ! -t 0 ]; then
    # Non-interactive: use saved config or default to qwenproxy
    BRAIN2_PROVIDER="${_cfg_provider:-qwenproxy}"
  else
    echo ""
    green '╔═══════════════════════════════════════╗'
    green '║ Brain 2 — Provider Selection           ║'
    green '╚═══════════════════════════════════════╝'
    echo ""
	echo ' [1] Qwen 3.6 Plus — free cloud via QwenProxy (requires Qwen account)'
	echo ' [2] Local model — any OpenAI-compatible LLM (Ollama, LM Studio, llama.cpp...)'
	echo ' [3] FreeLLM — free cloud LLM via FreeTheAI.xyz'
	echo ' [4] Skip Brain 2 — fall back to Brain 1 only'
	echo ""
	read -rp 'Choose [1-4]: ' _provider_choice
	case "$_provider_choice" in
	1)
		if check_ubuntu_brain2; then
			BRAIN2_PROVIDER=qwenproxy
		else
			echo ""
		dim " QwenProxy not supported on this Ubuntu version."
		dim " You can still use a local model instead."
			read -rp 'Configure a local model instead? [y/N]: ' _use_local
			if [[ "$_use_local" =~ ^[Yy]$ ]]; then
				BRAIN2_PROVIDER=local
				prompt_local_llm
			else
				BRAIN2_ENABLED=0
				export BRAIN2_ENABLED
			fi
		fi
		;;
	2)
		BRAIN2_PROVIDER=local
		prompt_local_llm
		;;
	3)
		BRAIN2_PROVIDER=freellm
		prompt_freellm
		;;
	4)
		BRAIN2_ENABLED=0
		export BRAIN2_ENABLED
		;;
	*)
		BRAIN2_PROVIDER=qwenproxy
		;;
	esac
  fi
fi
export BRAIN2_PROVIDER

echo ""
if [ "$BRAIN2_ENABLED" = '1' ]; then
if [ "$BRAIN2_PROVIDER" = 'qwenproxy' ]; then
	green '╔═══════════════════════════════════╗'
	green '║ Noxem — Starting Servers (Cloud) ║'
	green '╚═══════════════════════════════════╝'
elif [ "$BRAIN2_PROVIDER" = 'freellm' ]; then
	green '╔═══════════════════════════════════╗'
	green '║ Noxem — Starting Servers (FreeLLM) ║'
	green '╚═══════════════════════════════════╝'
else
	green '╔═══════════════════════════════════╗'
	green '║ Noxem — Starting Servers (Local) ║'
	green '╚═══════════════════════════════════╝'
fi
else
  green '╔═══════════════════════════════════╗'
  green '║ Noxem — Brain 1 Only              ║'
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
export RLM_LLM_TIMEOUT=${RLM_LLM_TIMEOUT:-60}
export EXTRACT_TIMEOUT_MS=${EXTRACT_TIMEOUT_MS:-60000}
export VECTOR_BACKEND=${VECTOR_BACKEND:-hybrid}
export TURBOVEC_URL=${TURBOVEC_URL:-http://127.0.0.1:3003}
export BRAIN2_ENABLED
export NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
node "$MEMORY_SERVER" &
MEMORY_PID=$!
wait_for_port $MEMORY_PORT "Memory server" 180

# 1b. TurboVec sidecar (hybrid mode: TurboVec + sqlite-vec)
NOXEM_PYTHON_BIN="${NOXEM_PYTHON:-}"
if [ -z "$NOXEM_PYTHON_BIN" ]; then
  if [ -f "${HOME}/.hermes/noxem-venv/bin/python" ]; then
    NOXEM_PYTHON_BIN="${HOME}/.hermes/noxem-venv/bin/python"
  elif command -v python3 &>/dev/null; then
    NOXEM_PYTHON_BIN="python3"
  elif command -v python &>/dev/null; then
    NOXEM_PYTHON_BIN="python"
  fi
fi
TURBOVEC_PORT=${TURBOVEC_PORT:-3003}
if [ -n "$NOXEM_PYTHON_BIN" ] && [ -f "$NOXEM_DIR/server/turbovec_proxy.py" ]; then
  dim " Starting TurboVec sidecar (port $TURBOVEC_PORT)..."
  "$NOXEM_PYTHON_BIN" "$NOXEM_DIR/server/turbovec_proxy.py" &
  TURBOVEC_PID=$!
  wait_for_port $TURBOVEC_PORT "TurboVec" 10 || {
    dim " TurboVec unavailable — using sqlite-vec fallback"
    TURBOVEC_PID=""
  }
else
  dim " TurboVec sidecar skipped (python or turbovec_proxy.py not found)"
  TURBOVEC_PID=""
fi

# 2. Brain 2 — QwenProxy + adapter, or local model adapter
if [ "$BRAIN2_ENABLED" = '1' ]; then
  if [ "$BRAIN2_PROVIDER" = 'local' ] || [ "$BRAIN2_PROVIDER" = 'freellm' ]; then
    # ── Local LLM mode ──────────────────────────────────────
    if [ "$BRAIN2_PROVIDER" = 'freellm' ]; then echo "[2/2] Starting Brain 2 (FreeLLM)..."; else echo "[2/2] Starting Brain 2 (Local model)..."; fi

    # Verify the local endpoint is reachable
    dim " Checking local LLM endpoint..."
    local_base_url="${LOCAL_LLM_URL:-${LLM_URL%\/chat\/completions}}"
    if curl -s -o /dev/null --connect-timeout 3 "$local_base_url/models" 2>/dev/null; then
      green " Local LLM is reachable at $local_base_url"
    else
      red " WARNING: Local LLM not reachable at $local_base_url"
      dim " Make sure your LLM server is running. The adapter will proxy when it becomes available."
    fi

    # Export adapter env vars
    export QWENPROXY_URL="http://127.0.0.1:${QWENPROXY_PORT}"  # not used in local mode, but set for compat

    # Start the LLM adapter in local passthrough mode
    dim " Starting LLM adapter (local mode)..."
    node "$ADAPTER_SERVER" &
    ADAPTER_PID=$!
    wait_for_port $LLM_PORT "Adapter" 15

    echo ""
    green 'Both servers ready! (local mode)'
    echo ' Memory server  -> http://127.0.0.1:'$MEMORY_PORT
    echo ' LLM adapter    -> http://127.0.0.1:'$LLM_PORT
    echo ' Local endpoint -> '"${LOCAL_LLM_URL:-${LLM_URL}}"
    echo ' Model          -> '"${LLM_MODEL}"
    echo ''

  else
    # ── QwenProxy mode (cloud) ──────────────────────────────
    echo "[2/2] Starting Brain 2 (QwenProxy)..."

    # Setup QwenProxy (install, credentials)
    if ! setup_qwenproxy; then
      red " QwenProxy setup failed — continuing without Brain 2"
      BRAIN2_ENABLED=0
      export BRAIN2_ENABLED
    else
# Start QwenProxy server (port already cleaned up above)
      dim " Starting QwenProxy server..."
      mkdir -p "$HOME/.hermes" && (cd "$QWENPROXY_DIR" && node src/start.js >"$HOME/.hermes/qwenproxy.log" 2>&1) &
      QWENPROXY_PID=$!
      dim "  (QwenProxy must complete browser login before serving — this takes 30-90s)"
dim "  Logs: tail -f ~/.hermes/qwenproxy.log"
wait_for_port $QWENPROXY_PORT "QwenProxy" 180

      # Start the LLM adapter in QwenProxy mode
      dim " Starting LLM adapter (QwenProxy mode)..."
      export QWENPROXY_URL="http://127.0.0.1:${QWENPROXY_PORT}"
      node "$ADAPTER_SERVER" &
      ADAPTER_PID=$!
      wait_for_port $LLM_PORT "Adapter" 15

      echo ""
      green 'Both servers ready! (QwenProxy/cloud mode)'
      echo ' Memory server  -> http://127.0.0.1:'$MEMORY_PORT
      echo ' QwenProxy      -> http://127.0.0.1:'$QWENPROXY_PORT
      echo ' LLM adapter    -> http://127.0.0.1:'$LLM_PORT
      echo ''
    fi
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
  if [ "$BRAIN2_PROVIDER" = "local" ]; then
    green "Hermes session ended. (Brain 1 + Brain 2 local)"
  else
    green "Hermes session ended. (Brain 1 + Brain 2 QwenProxy)"
  fi
else
  green "Hermes session ended. (Brain 1 only)"
fi

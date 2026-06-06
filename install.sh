#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$APP_DIR/server"
# Detect plugin location: could be in repo structure or already in hermes plugins dir
if [ -f "$APP_DIR/plugins/memory/noxem/__init__.py" ]; then
PLUGIN_DIR="$APP_DIR/plugins/memory/noxem"
elif [ -f "$APP_DIR/__init__.py" ]; then
# Already installed as ~/.hermes/plugins/noxem/ — plugin files are at root
PLUGIN_DIR="$APP_DIR"
else
echo "ERROR: Cannot find plugin __init__.py. Run from the noxem repo root."
exit 1
fi
HERMES_USER_PLUGIN_DIR="${HOME}/.hermes/plugins/noxem"
HERMES_NESTED_PLUGIN_DIR="${HOME}/.hermes/plugins/memory/noxem"
HERMES_HOOKS_DIR="${HOME}/.hermes/agent-hooks"
HERMES_SERVER_DIR="${HOME}/.hermes/noxem-server"

# ── OS detection ──
OS="$(uname -s)"
IS_MACOS=false
IS_WSL=false
if [ "$OS" = "Darwin" ]; then
IS_MACOS=true
fi
if grep -qi microsoft /proc/version 2>/dev/null; then
IS_WSL=true
fi

# ── WSL networking fix ──
# WSL2's auto-generated /etc/resolv.conf uses the NAT gateway (172.x.x.x)
# which often can't resolve HuggingFace CDN hosts, causing "fetch failed" on
# model downloads. Fix: point DNS to Google's public resolvers and pin the
# file so WSL doesn't overwrite it on restart.
if $IS_WSL; then
if ! grep -q '8\.8\.8\.8' /etc/resolv.conf 2>/dev/null; then
echo "Fixing WSL DNS (Google Public DNS)..."
sudo rm -f /etc/resolv.conf 2>/dev/null || true
sudo bash -c 'echo "nameserver 8.8.8.8" > /etc/resolv.conf' 2>/dev/null && \
sudo bash -c 'echo "nameserver 8.8.4.4" >> /etc/resolv.conf' 2>/dev/null || true
# Prevent WSL from overwriting on restart
if [ -f /etc/wsl.conf ]; then
if ! grep -q 'generateResolvConf' /etc/wsl.conf 2>/dev/null; then
sudo bash -c 'echo -e "\n[network]\ngenerateResolvConf = false" >> /etc/wsl.conf' 2>/dev/null || true
fi
else
sudo bash -c 'echo -e "[network]\ngenerateResolvConf = false" > /etc/wsl.conf' 2>/dev/null || true
fi
# Lock the file so WSL doesn't overwrite it
sudo chattr +i /etc/resolv.conf 2>/dev/null || true
echo " Done — DNS set to 8.8.8.8 / 8.8.4.4"
else
echo " WSL DNS already configured"
fi
fi

# Clear bash hash cache so hermes-noxem points to the right path
hash -r 2>/dev/null || true

echo "========================================"
echo " Noxem Installation for Hermes Agent"
echo "========================================"
echo ""

# ── Pre-flight: Node.js ──
if command -v node &>/dev/null; then
NODE_VER="$(node --version | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_VER" -lt 22 ]; then
echo " Node.js $NODE_VER detected -- v22+ required."
exit 1
fi
echo " Node.js $(node --version)"
else
echo " Node.js not found -- install Node.js 22+ first."
echo "  Recommended: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
exit 1
fi

# ── Pre-flight: Python 3 ──
if command -v python3 &>/dev/null; then
PY_VER="$(python3 --version 2>&1 | head -1)"
echo " $PY_VER"
else
echo " Python3 not found -- installing..."
if $IS_MACOS; then
echo "  Install via: brew install python3"
exit 1
else
sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-pip python3-venv 2>&1 | tail -1
echo " Installed python3"
fi
fi

# ── Pre-flight: pip3 ──
if command -v pip3 &>/dev/null; then
echo " pip3 $(pip3 --version 2>&1 | awk '{print $2}')"
else
echo " pip3 not found -- installing..."
if $IS_MACOS; then
echo "  Install via: python3 -m ensurepip"
python3 -m ensurepip 2>/dev/null || echo "  pip install skipped"
else
sudo apt-get install -y -qq python3-pip 2>&1 | tail -1
echo " Installed pip3"
fi
fi

# ── Pre-flight: build tools (needed for better-sqlite3, sharp native builds) ──
if ! $IS_MACOS; then
if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
echo " Build tools not found -- installing build-essential..."
sudo apt-get update -qq && sudo apt-get install -y -qq build-essential python3-dev 2>&1 | tail -1
echo " Installed build-essential + python3-dev"
else
echo " Build tools: $(g++ --version 2>&1 | head -1 | awk '{print $3}')"
fi
fi

# ── Pre-flight: Hermes ──
if [ -d "${HOME}/.hermes" ]; then
echo " Hermes installation found at ${HOME}/.hermes"
else
echo " Hermes not found at ${HOME}/.hermes -- some features may not work"
fi
echo ""

# ── 1. Node.js dependencies ──
echo "[1/9] Installing server npm dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo " Done"

# ── 2. Python dependencies ──
echo "[2/9] Installing Python dependencies..."
PIP_FLAGS="--break-system-packages"
# Use venv if available, otherwise system pip
NOXEM_VENV="${HOME}/.hermes/noxem-venv"
if [ ! -d "$NOXEM_VENV" ]; then
python3 -m venv "$NOXEM_VENV" 2>/dev/null && echo " Created venv at $NOXEM_VENV" || true
fi

# Determine pip command (venv or system)
if [ -f "$NOXEM_VENV/bin/pip" ]; then
PIP_CMD="$NOXEM_VENV/bin/pip"
PIP_FLAGS=""
echo " Using venv pip: $PIP_CMD"
# Create symlinks so the sidecars can find the venv packages
PY_SITE=$($NOXEM_VENV/bin/python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || echo "$NOXEM_VENV/lib/python3/site-packages")
# Note: sidecars should use the venv python: $NOXEM_VENV/bin/python3
else
PIP_CMD="pip3"
echo " Using system pip3"
fi

# Core Python deps (rlm_sidecar.py + turbovec_proxy.py)
# httpx is optional — rlm_sidecar.py has urllib fallback
# numpy is required by turbovec_proxy.py
# turbovec/fastapi/uvicorn are optional — checked at runtime with graceful fallback
CORE_PY_DEPS="httpx numpy"
OPTIONAL_PY_DEPS="turbovec fastapi uvicorn"

$PIP_CMD install $PIP_FLAGS --quiet $CORE_PY_DEPS 2>&1 | tail -1
echo " Core: $CORE_PY_DEPS"

$PIP_CMD install $PIP_FLAGS --quiet $OPTIONAL_PY_DEPS 2>&1 | tail -2 || true
echo " Optional: $OPTIONAL_PY_DEPS (sidecar features — graceful fallback if missing)"

# Write a helper script that sidecars can use to find the venv python
if [ -d "$NOXEM_VENV" ]; then
cat > "$SERVER_DIR/.noxem-python" << PYEOF
#!/usr/bin/env bash
# Noxem Python helper — uses venv if available, falls back to system python3
if [ -f "$NOXEM_VENV/bin/python3" ]; then
exec "$NOXEM_VENV/bin/python3" "$@"
else
exec python3 "$@"
fi
PYEOF
chmod +x "$SERVER_DIR/.noxem-python"
# Update sidecar spawn commands to use venv python
echo " Created $SERVER_DIR/.noxem-python (venv-aware python launcher)"
fi
echo " Done"

# ── 3. Hermes plugin (clean install) ──
echo "[3/9] Installing Noxem plugin for Hermes..."

# Skip copy if already running from the correct plugin discovery path
if [ "$PLUGIN_DIR" = "$HERMES_USER_PLUGIN_DIR" ]; then
echo " Already in plugin discovery path ($HERMES_USER_PLUGIN_DIR)"
else
# Primary: install to user-plugins discovery path
rm -rf "$HERMES_USER_PLUGIN_DIR"
mkdir -p "$HERMES_USER_PLUGIN_DIR"
cp "$PLUGIN_DIR/__init__.py" "$HERMES_USER_PLUGIN_DIR/"
cp "$PLUGIN_DIR/plugin.yaml" "$HERMES_USER_PLUGIN_DIR/"
cp "$PLUGIN_DIR/cli.py" "$HERMES_USER_PLUGIN_DIR/" 2>/dev/null || true
echo " Installed to $HERMES_USER_PLUGIN_DIR"
fi

# Fallback: also install to nested path (if different from primary)
if [ "$HERMES_NESTED_PLUGIN_DIR" != "$HERMES_USER_PLUGIN_DIR" ]; then
rm -rf "$HERMES_NESTED_PLUGIN_DIR"
mkdir -p "$HERMES_NESTED_PLUGIN_DIR"
cp "$PLUGIN_DIR/"* "$HERMES_NESTED_PLUGIN_DIR/" 2>/dev/null || true
echo " Also installed to $HERMES_NESTED_PLUGIN_DIR"
fi

# Verifying plugin structure
echo " Verifying plugin structure..."
for f in plugin.yaml __init__.py cli.py; do
if [ -f "$HERMES_USER_PLUGIN_DIR/$f" ]; then
echo " OK $f"
else
echo " MISSING $f"
fi
done

# ── 4. Verify Python imports ──
echo "[4/9] Verifying Python imports..."
cd "$HERMES_USER_PLUGIN_DIR"
if python3 -c "from __init__ import NoxemMemoryProvider; print(' NoxemMemoryProvider imports OK')" 2>/dev/null; then
:
else
echo " Import check skipped (will work at runtime via Hermes plugin loader)"
fi

# Verify sidecar dependencies
if [ -d "$NOXEM_VENV" ]; then
SIDE_PY="$NOXEM_VENV/bin/python3"
else
SIDE_PY="python3"
fi
echo -n " RLM sidecar deps: "
$SIDE_PY -c "import httpx; print('httpx OK')" 2>/dev/null || echo "httpx missing (urllib fallback available)"
echo -n " TurboVec sidecar deps: "
$SIDE_PY -c "import turbovec, fastapi, uvicorn, numpy; print('all OK')" 2>/dev/null || echo "some missing (sidecar features disabled gracefully)"

# ── 5. Shell hooks ──
echo "[5/9] Installing shell hooks..."
mkdir -p "$HERMES_HOOKS_DIR"
cp "$APP_DIR/hooks/"*.mjs "$HERMES_HOOKS_DIR/" 2>/dev/null || true
chmod +x "$HERMES_HOOKS_DIR/"*.mjs 2>/dev/null || true
echo " Done"

# ── 6. Configure noxem server settings ──
echo "[6/9] Writing Noxem server config..."
NOXEM_CONFIG="${HOME}/.hermes/noxem.json"

# Write noxem server config (port URLs only — NOT the hermes memory provider setting)
cat > "$NOXEM_CONFIG" << NOXEMEOF
{
"memory_server": "http://127.0.0.1:${MEMORY_PORT:-3001}",
"brain2_provider": "qwenproxy",
"llm_url": "http://127.0.0.1:${LLM_PORT:-${GEMMA4_PORT:-8000}}/v1/chat/completions",
"llm_model": "qwen3-235b-a22b",
"llm_api_key": "",
"embedding_enabled": "true"
}
NOXEMEOF
echo " Wrote $NOXEM_CONFIG"

# NOTE: We do NOT auto-set memory.provider in config.yaml.
# The user must run "hermes memory setup" and choose "noxem" themselves.
# hermes-noxem launcher will check and refuse to run if not configured.

# ── 7. Server deployment ──
echo "[7/9] Deploying server to persistent location..."
# Backup data before removing (preserves user DB on reinstall)
        _data_backup=""
        if [ -d "$HERMES_SERVER_DIR/data" ]; then
          _data_backup=$(mktemp -d)
          cp -r "$HERMES_SERVER_DIR/data/"* "$_data_backup/" 2>/dev/null || true
        fi
        rm -rf "$HERMES_SERVER_DIR"
mkdir -p "$HERMES_SERVER_DIR"
        # Restore backed-up data
        if [ -n "$_data_backup" ] && [ -d "$_data_backup" ]; then
          mkdir -p "$HERMES_SERVER_DIR/data"
          cp -r "$_data_backup/"* "$HERMES_SERVER_DIR/data/" 2>/dev/null || true
          rm -rf "$_data_backup"
        fi
# Copy full repo structure (server, plugins, hooks, launcher, scripts)
if command -v rsync &>/dev/null; then
rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' "$APP_DIR/" "$HERMES_SERVER_DIR/" 2>/dev/null
else
# Fallback without rsync: cp -r and manually exclude
cp -r "$APP_DIR/"* "$HERMES_SERVER_DIR/" 2>/dev/null || true
rm -rf "$HERMES_SERVER_DIR/node_modules" "$HERMES_SERVER_DIR/.git" "$HERMES_SERVER_DIR/data" 2>/dev/null || true
fi
# Fix CRLF line endings (Windows git checkout can introduce carriage returns)
find "$HERMES_SERVER_DIR" -type f \( -name "*.sh" -o -name "*.mjs" -o -name "*.js" -o -name "*.py" \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true
chmod +x "$HERMES_SERVER_DIR/noxem-launcher.sh" 2>/dev/null || true
chmod +x "$HERMES_SERVER_DIR/server/"*.sh 2>/dev/null || true
# Install npm dependencies in the deployed server
cd "$HERMES_SERVER_DIR/server" 2>/dev/null && npm install --no-audit --no-fund 2>&1 | tail -1
# Copy the venv helper if created
if [ -f "$SERVER_DIR/.noxem-python" ]; then
cp "$SERVER_DIR/.noxem-python" "$HERMES_SERVER_DIR/server/" 2>/dev/null || true
chmod +x "$HERMES_SERVER_DIR/server/.noxem-python" 2>/dev/null || true
fi
# Install Qwen-Proxy deps in the deployed copy (rsync excludes node_modules)
if [ -f "$HERMES_SERVER_DIR/qwen-proxy/package.json" ]; then
  cd "$HERMES_SERVER_DIR/qwen-proxy" && npm install --no-audit --no-fund 2>&1 | tail -1
fi
echo " Deployed to $HERMES_SERVER_DIR"

# ── 8. Qwen-Proxy npm dependencies ──
echo "[8/9] Installing Qwen-Proxy npm dependencies..."
QP_DIR="$APP_DIR/qwen-proxy"
if [ -f "$QP_DIR/package.json" ]; then
  cd "$QP_DIR"
  npm install --no-audit --no-fund 2>&1 | tail -1
  echo " Done"
else
  echo " No qwen-proxy/ directory found — skipping (Brain 2 cloud mode won't work)"
fi

# ── 9. Launcher setup ──
echo "[9/9] Setting up launcher..."
chmod +x "$APP_DIR/noxem-launcher.sh" 2>/dev/null || true
INSTALLED=false

# On Linux/macOS: install wrapper in PATH
WRAPPER_PATH="/usr/local/bin/hermes-noxem"
WRAPPER_CONTENT='#!/usr/bin/env bash
set -euo pipefail
exec '"$HERMES_SERVER_DIR"'/noxem-launcher.sh "$@"'

# Try writeable first (no sudo needed), then sudo with TTY check,
# then sudo with NOPASSWD. Avoids hanging on non-interactive shells.
if [ -w "/usr/local/bin" ]; then
printf "%s\n" "$WRAPPER_CONTENT" > "$WRAPPER_PATH" && chmod +x "$WRAPPER_PATH" && { echo " Installed to $WRAPPER_PATH"; INSTALLED=true; }
elif command -v sudo &>/dev/null && [ -t 0 ]; then
printf "%s\n" "$WRAPPER_CONTENT" | sudo tee "$WRAPPER_PATH" >/dev/null 2>&1 && sudo chmod +x "$WRAPPER_PATH" && { echo " Installed to $WRAPPER_PATH (via sudo)"; INSTALLED=true; }
elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
printf "%s\n" "$WRAPPER_CONTENT" | sudo tee "$WRAPPER_PATH" >/dev/null 2>&1 && sudo chmod +x "$WRAPPER_PATH" && { echo " Installed to $WRAPPER_PATH (via sudo NOPASSWD)"; INSTALLED=true; }
fi

# Fallback: add alias to shell rc file
if ! $INSTALLED; then
if $IS_MACOS; then
SHELL_RC="${HOME}/.zshrc"
else
SHELL_RC="${HOME}/.bashrc"
fi

ALIAS_LINE="alias hermes-noxem='$HERMES_SERVER_DIR/noxem-launcher.sh'"

# Remove any existing hermes-noxem alias (may point to stale path)
if [ -f "$SHELL_RC" ]; then
sed -i '/alias hermes-noxem=/d' "$SHELL_RC" 2>/dev/null || true
sed -i '/# Noxem -- launch Hermes/d' "$SHELL_RC" 2>/dev/null || true
fi

touch "$SHELL_RC" 2>/dev/null || true
printf '\n# Noxem -- launch Hermes with memory servers\n%s\n' "$ALIAS_LINE" >> "$SHELL_RC"
echo " Added 'hermes-noxem' alias to $SHELL_RC"
fi

echo ""
echo "========================================"
echo " Installation Complete!"
echo "========================================"
echo ""
echo "DEPENDENCIES INSTALLED:"
echo " Node.js: npm packages (express, better-sqlite3, sqlite-vec, etc.)"
echo " Qwen-Proxy: npm packages (ali-oss, axios, express, multer, etc.)"
echo " Python core: httpx, numpy"
echo " Python optional: turbovec, fastapi, uvicorn (sidecar features)"
if [ -d "$NOXEM_VENV" ]; then
echo " Python venv: $NOXEM_VENV"
echo " Sidecars use: $NOXEM_VENV/bin/python3"
fi
echo ""
echo "NEXT STEPS:"
echo " 1. Set memory provider: hermes memory setup"
echo " -> Select 'noxem' when prompted"
echo ""
echo " 2. Start with Noxem: hermes-noxem"
echo " Or start normally: hermes chat"
echo ""
echo "NOTE: hermes-noxem will check that noxem is your"
echo "active memory provider before starting servers."
echo "First run downloads models (~2-3GB total)."
echo ""
echo "OPTIONAL SIDEKICKS (pip install into venv if needed):"
echo " RLM sidecar:  httpx (has urllib fallback)"
echo " TurboVec KNN: turbovec fastapi uvicorn numpy"
echo "========================================"

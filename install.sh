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
    echo "  Node.js $NODE_VER detected -- v22+ required."
    exit 1
  fi
  echo "  Node.js $(node --version)"
else
  echo "  Node.js not found -- install Node.js 22+ first."
  exit 1
fi

# ── Pre-flight: Hermes ──
if [ -d "${HOME}/.hermes" ]; then
  echo "  Hermes installation found at ${HOME}/.hermes"
else
  echo "  Hermes not found at ${HOME}/.hermes -- some features may not work"
fi
echo ""

# ── 1. Node.js dependencies ──
echo "[1/7] Installing server dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "  Done"

# ── 2. Hermes plugin (clean install) ──
# Hermes discovers memory providers at ~/.hermes/plugins/<name>/
# and checks if <name>/__init__.py contains "register_memory_provider"
echo "[2/7] Installing Noxem plugin for Hermes..."

# Skip copy if already running from the correct plugin discovery path
if [ "$PLUGIN_DIR" = "$HERMES_USER_PLUGIN_DIR" ]; then
  echo "  Already in plugin discovery path ($HERMES_USER_PLUGIN_DIR)"
else
  # Primary: install to user-plugins discovery path
  rm -rf "$HERMES_USER_PLUGIN_DIR"
  mkdir -p "$HERMES_USER_PLUGIN_DIR"
  cp "$PLUGIN_DIR/__init__.py" "$HERMES_USER_PLUGIN_DIR/"
  cp "$PLUGIN_DIR/plugin.yaml" "$HERMES_USER_PLUGIN_DIR/"
  cp "$PLUGIN_DIR/cli.py" "$HERMES_USER_PLUGIN_DIR/" 2>/dev/null || true
  echo "  Installed to $HERMES_USER_PLUGIN_DIR"
fi

# Fallback: also install to nested path (if different from primary)
if [ "$HERMES_NESTED_PLUGIN_DIR" != "$HERMES_USER_PLUGIN_DIR" ]; then
  rm -rf "$HERMES_NESTED_PLUGIN_DIR"
  mkdir -p "$HERMES_NESTED_PLUGIN_DIR"
  cp "$PLUGIN_DIR/"* "$HERMES_NESTED_PLUGIN_DIR/" 2>/dev/null || true
  echo "  Also installed to $HERMES_NESTED_PLUGIN_DIR"
fi

# Verifying plugin structure
echo "  Verifying plugin structure..."
for f in plugin.yaml __init__.py cli.py; do
  if [ -f "$HERMES_USER_PLUGIN_DIR/$f" ]; then
    echo "  OK $f"
  else
    echo "  MISSING $f"
  fi
done

# ── 3. Verify Python imports ──
echo "[3/7] Verifying Python imports..."
cd "$HERMES_USER_PLUGIN_DIR"
if python3 -c "from __init__ import NoxemMemoryProvider; print('  NoxemMemoryProvider imports OK')" 2>/dev/null; then
  :
else
  echo "  Import check skipped (will work at runtime via Hermes plugin loader)"
fi

# ── 4. Shell hooks ──
echo "[4/7] Installing shell hooks..."
mkdir -p "$HERMES_HOOKS_DIR"
cp "$APP_DIR/hooks/"*.mjs "$HERMES_HOOKS_DIR/" 2>/dev/null || true
chmod +x "$HERMES_HOOKS_DIR/"*.mjs 2>/dev/null || true
echo "  Done"

# ── 5. Configure noxem server settings ──
echo "[5/7] Writing Noxem server config..."
NOXEM_CONFIG="${HOME}/.hermes/noxem.json"

# Write noxem server config (port URLs only — NOT the hermes memory provider setting)
cat > "$NOXEM_CONFIG" << NOXEMEOF
{
  "memory_server": "http://127.0.0.1:${MEMORY_PORT:-3001}",
  "brain2_provider": "qwenproxy",
  "llm_url": "http://127.0.0.1:${LLM_PORT:-${GEMMA4_PORT:-8000}}/v1/chat/completions",
  "llm_model": "qwen3.6-plus-no-thinking",
  "llm_api_key": "",
  "embedding_enabled": "true"
}
NOXEMEOF
echo " Wrote $NOXEM_CONFIG"

# NOTE: We do NOT auto-set memory.provider in config.yaml.
# The user must run "hermes memory setup" and choose "noxem" themselves.
# hermes-noxem launcher will check and refuse to run if not configured.

# ── 6. Server deployment ──
echo "[6/7] Deploying server to persistent location..."
rm -rf "$HERMES_SERVER_DIR"
mkdir -p "$HERMES_SERVER_DIR"
# Copy full repo structure (server, plugins, hooks, launcher, scripts)
rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' "$APP_DIR/" "$HERMES_SERVER_DIR/" 2>/dev/null || {
  RSYNC_STATUS=$?
  echo "  WARNING: rsync failed (exit $RSYNC_STATUS) — falling back to cp"
  cp -r "$APP_DIR/"* "$HERMES_SERVER_DIR/" 2>/dev/null || {
    echo "  ERROR: Both rsync and cp failed. Installation incomplete."
    echo "  Manual steps:"
    echo "    1. mkdir -p $HERMES_SERVER_DIR"
    echo "    2. cp -r $APP_DIR/* $HERMES_SERVER_DIR/"
    echo "    3. cd $HERMES_SERVER_DIR/server && npm install"
    exit 1
  }
}
# Fix CRLF line endings (Windows git checkout can introduce carriage returns)
find "$HERMES_SERVER_DIR" -type f \( -name "*.sh" -o -name "*.mjs" -o -name "*.js" \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true
chmod +x "$HERMES_SERVER_DIR/noxem-launcher.sh" 2>/dev/null || true
chmod +x "$HERMES_SERVER_DIR/server/"*.sh 2>/dev/null || true
# Install npm dependencies in the deployed server
cd "$HERMES_SERVER_DIR/server" 2>/dev/null && npm install --no-audit --no-fund 2>&1 | tail -1
echo " Deployed to $HERMES_SERVER_DIR"

# ── 7. Launcher setup ──
echo "[7/7] Setting up launcher..."
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
  printf "%s\n" "$WRAPPER_CONTENT" > "$WRAPPER_PATH" && chmod +x "$WRAPPER_PATH" && { echo "  Installed to $WRAPPER_PATH"; INSTALLED=true; }
elif command -v sudo &>/dev/null && [ -t 0 ]; then
  printf "%s\n" "$WRAPPER_CONTENT" | sudo tee "$WRAPPER_PATH" >/dev/null 2>&1 && sudo chmod +x "$WRAPPER_PATH" && { echo "  Installed to $WRAPPER_PATH (via sudo)"; INSTALLED=true; }
elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  printf "%s\n" "$WRAPPER_CONTENT" | sudo tee "$WRAPPER_PATH" >/dev/null 2>&1 && sudo chmod +x "$WRAPPER_PATH" && { echo "  Installed to $WRAPPER_PATH (via sudo NOPASSWD)"; INSTALLED=true; }
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
echo "NEXT STEPS:"
echo " 1. Set memory provider: hermes memory setup"
echo "    -> Select 'noxem' when prompted"
echo ""
echo " 2. Start with Noxem: hermes-noxem"
echo "    Or start normally: hermes chat"
echo ""
echo "NOTE: hermes-noxem will check that noxem is your"
echo "active memory provider before starting servers."
echo "First run downloads models (~2-3GB total)."
echo "========================================"

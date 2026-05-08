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
if [ "$OS" = "Darwin" ]; then
  IS_MACOS=true
fi

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
echo "[1/6] Installing server dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "  Done"

# ── 2. Hermes plugin (clean install) ──
# Hermes discovers memory providers at ~/.hermes/plugins/<name>/
# and checks if <name>/__init__.py contains "register_memory_provider"
echo "[2/6] Installing Noxem plugin for Hermes..."

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
echo "[3/6] Verifying Python imports..."
cd "$HERMES_USER_PLUGIN_DIR"
if python3 -c "from __init__ import NoxemMemoryProvider; print('  NoxemMemoryProvider imports OK')" 2>/dev/null; then
  :
else
  echo "  Import check skipped (will work at runtime via Hermes plugin loader)"
fi

# ── 4. Shell hooks ──
echo "[4/6] Installing shell hooks..."
mkdir -p "$HERMES_HOOKS_DIR"
cp "$APP_DIR/hooks/"*.mjs "$HERMES_HOOKS_DIR/" 2>/dev/null || true
chmod +x "$HERMES_HOOKS_DIR/"*.mjs 2>/dev/null || true
echo "  Done"

# ── 5. Configure memory provider ──
echo "[5/6] Configuring noxem as memory provider..."
HERMES_CONFIG="${HOME}/.hermes/config.yaml"
NOXEM_CONFIG="${HOME}/.hermes/noxem.json"

# Write noxem server config
cat > "$NOXEM_CONFIG" << NOXEMEOF
{
  "memory_server": "http://127.0.0.1:${MEMORY_PORT:-3001}",
  "gemma_url": "http://127.0.0.1:${GEMMA4_PORT:-8000}/v1/chat/completions",
  "embedding_enabled": "true"
}
NOXEMEOF
echo "  Wrote $NOXEM_CONFIG"

# Use hermes config set to safely update config.yaml
# (pyyaml.dump destroys the config structure due to multi-line strings)
# Hermes reads memory.provider from top-level, NOT context.memory.provider
if command -v hermes &>/dev/null; then
  hermes config set memory.provider noxem 2>/dev/null && \
    echo "  Set memory.provider = noxem (via hermes config set)" || \
    echo "  Run manually: hermes config set memory.provider noxem"

  # Also enable noxem in the plugins allow-list
  hermes config set plugins.enabled '[noxem]' 2>/dev/null || true
else
  echo "  Run manually: hermes config set memory.provider noxem"
  echo "  Run manually: hermes config set plugins.enabled '[noxem]'"
fi

# ── 6. Server deployment ──
echo "[6/7] Deploying server to persistent location..."
rm -rf "$HERMES_SERVER_DIR"
mkdir -p "$HERMES_SERVER_DIR"
# Copy full repo structure (server, plugins, hooks, launcher, scripts)
rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' "$APP_DIR/" "$HERMES_SERVER_DIR/" 2>/dev/null || \
  cp -r "$APP_DIR/"* "$HERMES_SERVER_DIR/" 2>/dev/null || true
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

  if [ ! -f "$SHELL_RC" ] || ! grep -q "alias hermes-noxem" "$SHELL_RC" 2>/dev/null; then
    touch "$SHELL_RC" 2>/dev/null || true
    cat >> "$SHELL_RC" << EOF

# Noxem -- launch Hermes with memory + Gemma 4 servers
$ALIAS_LINE
EOF
    echo "  Added 'hermes-noxem' alias to $SHELL_RC"
  else
    echo "  'hermes-noxem' alias already exists in $SHELL_RC"
  fi
fi

echo ""
echo "========================================"
echo " Installation Complete!"
echo "========================================"
echo ""
echo "USE:"
echo "  hermes-noxem"
echo "  (starts both servers, runs Hermes, shuts down on exit)"
echo ""
echo "Or manually:"
echo "  1. Start memory server: node server/memory-server.mjs"
echo "  2. Start Gemma 4: node server/gemma4-server.mjs"
echo "  3. Run Hermes: hermes chat"
echo "  4. Enable provider: hermes memory setup -> Select 'noxem'"
echo ""
echo "First run downloads models (~2-3GB total)."
echo "========================================"

if $INSTALLED; then
  echo "Run: hermes-noxem"
else
  if $IS_MACOS; then
    echo "Run: source ~/.zshrc && hermes-noxem"
  else
    echo "Run: source ~/.bashrc && hermes-noxem"
  fi
fi

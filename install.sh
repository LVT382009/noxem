#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$APP_DIR/server"
PLUGIN_DIR="$APP_DIR/plugins/memory/noxem"
HERMES_PLUGIN_DIR="${HOME}/.hermes/plugins/memory/noxem"
HERMES_HOOKS_DIR="${HOME}/.hermes/agent-hooks"

echo "╔══════════════════════════════════════╗"
echo "║   Hermes Noxem Memory Provider      ║"
echo "║   AI-Powered Two-Brain Memory        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. Install Node.js deps
echo "[1/5] Installing memory server dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "  ✓ Server deps installed"

# 2. Install Python deps for Hermes plugin
echo "[2/5] Python plugin has no extra deps (stdlib only)"
echo "  ✓"

# 3. Install Hermes plugin
echo "[3/5] Installing Noxem plugin for Hermes..."
mkdir -p "$HERMES_PLUGIN_DIR"
cp "$PLUGIN_DIR/"* "$HERMES_PLUGIN_DIR/"
echo "  ✓ Plugin installed to $HERMES_PLUGIN_DIR"

# 4. Install shell hooks (backup)
echo "[4/5] Installing shell hooks..."
mkdir -p "$HERMES_HOOKS_DIR"
cp "$APP_DIR/hooks/"*.mjs "$HERMES_HOOKS_DIR/" 2>/dev/null || true
chmod +x "$HERMES_HOOKS_DIR/"*.mjs 2>/dev/null || true
echo "  ✓ Hooks copied"

# 5. Create start script
echo "[5/5] Creating start scripts..."
cat > "$APP_DIR/start.sh" << 'SCRIPT'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/server"
export ENABLE_EMBEDDING=true
export ENABLE_ADVISOR=true
export ENABLE_MAINTENANCE=true
exec node memory-server.mjs
SCRIPT
chmod +x "$APP_DIR/start.sh"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Installation Complete!                     ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║  1. Start the memory server:                 ║"
echo "║     bash $APP_DIR/start.sh                   ║"
echo "║                                              ║"
echo "║  2. Enable the provider in Hermes:           ║"
echo "║     hermes memory setup                      ║"
echo "║     → Select 'noxem' from the list           ║"
echo "║                                              ║"
echo "║  3. Verify:                                  ║"
echo "║     hermes noxem status                      ║"
echo "║                                              ║"
echo "║  Make sure Gemma 4 is running on port 8000   ║"
echo "║  for advisor mode. EmbeddingGemma 300M       ║"
echo "║  auto-downloads on first server start.       ║"
echo "╚══════════════════════════════════════════════╝"
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$APP_DIR/server"
PLUGIN_DIR="$APP_DIR/plugins/memory/noxem"
HERMES_PLUGIN_DIR="${HOME}/.hermes/plugins/memory/noxem"
HERMES_HOOKS_DIR="${HOME}/.hermes/agent-hooks"

echo "╔══════════════════════════════════════╗"
echo "║   Noxem — Memory Provider            ║"
echo "║   for Hermes Agent                   ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Node.js dependencies ──
echo "[1/6] Installing server dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "  ✓"

# ── 2. EmbeddingGemma 300M ──
echo "[2/6] Setting up EmbeddingGemma 300M..."
echo "  (auto-downloads on first start via Transformers.js)"
echo "  ✓"

# ── 3. Gemma 4 E2B ──
echo "[3/6] Setting up Gemma 4 E2B..."
echo "  Engine: Transformers.js + WebGPU"
echo "  Model:  onnx-community/gemma-4-E2B-it-ONNX (q4f16)"
echo "  Port:   8000"
echo "  (model auto-downloads on first start via Transformers.js)"
echo ""

if command -v npx &>/dev/null; then
  echo "  Checking Node.js GPU support..."
  node -e "
    try {
      require('@huggingface/transformers');
      console.log('  ✓ Transformers.js available');
    } catch(e) {
      // will install in step 1
    }
  " 2>/dev/null || true
fi
echo "  ✓"

# ── 4. Hermes plugin ──
echo "[4/6] Installing Noxem plugin for Hermes..."
mkdir -p "$HERMES_PLUGIN_DIR"
cp "$PLUGIN_DIR/"* "$HERMES_PLUGIN_DIR/"
echo "  ✓ Installed to $HERMES_PLUGIN_DIR"

# ── 5. Shell hooks (backup) ──
echo "[5/6] Installing shell hooks..."
mkdir -p "$HERMES_HOOKS_DIR"
cp "$APP_DIR/hooks/"*.mjs "$HERMES_HOOKS_DIR/" 2>/dev/null || true
chmod +x "$HERMES_HOOKS_DIR/"*.mjs 2>/dev/null || true
echo "  ✓"

# ── 6. Launcher alias ──
echo "[6/6] Setting up launcher..."
chmod +x "$APP_DIR/noxem-launcher.sh"

# Add alias if not present
SHELL_RC="${HOME}/.bashrc"
if ! grep -q "alias hermes-noxem" "$SHELL_RC" 2>/dev/null; then
  cat >> "$SHELL_RC" << EOF

# Noxem — launch Hermes with memory + Gemma 4 servers
alias hermes-noxem='$APP_DIR/noxem-launcher.sh'
EOF
  echo "  ✓ Added 'hermes-noxem' alias to $SHELL_RC"
else
  echo "  ✓ 'hermes-noxem' alias already exists"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Installation Complete!                     ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
echo "║  USE:                                        ║"
echo "║    hermes-noxem                              ║"
echo "║    (starts both servers, runs Hermes,        ║"
echo "║     shuts down servers on exit)              ║"
echo "║                                              ║"
echo "║  Or manually:                                ║"
echo "║    1. Start Gemma 4:                         ║"
echo "║       node server/gemma4-server.mjs          ║"
echo "║                                              ║"
echo "║    2. Start memory server:                   ║"
echo "║       node server/memory-server.mjs          ║"
echo "║                                              ║"
echo "║    3. Run Hermes:                            ║"
echo "║       hermes chat                            ║"
echo "║                                              ║"
echo "║    4. Enable provider:                       ║"
echo "║       hermes memory setup                    ║"
echo "║       → Select 'noxem'                       ║"
echo "║                                              ║"
echo "║  First run downloads models (~2-3GB total).  ║"
echo "║  WebGPU used if available, else CPU.         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Run: source ~/.bashrc && hermes-noxem"
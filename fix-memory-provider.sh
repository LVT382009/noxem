#!/usr/bin/env bash
# Fix memory provider config — run this if "hermes memory setup" selected "built-in only"
# Usage: bash fix-memory-provider.sh
set -euo pipefail

HERMES_CONFIG="${HOME}/.hermes/config.yaml"
NOXEM_CONFIG="${HOME}/.hermes/noxem.json"

echo "Configuring noxem as Hermes memory provider..."

# 1. Write noxem server config
mkdir -p "$(dirname "$NOXEM_CONFIG")"
cat > "$NOXEM_CONFIG" << EOF
{
  "memory_server": "http://127.0.0.1:${MEMORY_PORT:-3001}",
  "gemma_url": "http://127.0.0.1:${GEMMA4_PORT:-8000}/v1/chat/completions",
  "embedding_enabled": "true"
}
EOF
echo "✓ Wrote $NOXEM_CONFIG"

# 2. Set memory provider in hermes config
if [ ! -f "$HERMES_CONFIG" ]; then
  echo "✗ $HERMES_CONFIG not found — is Hermes installed?"
  exit 1
fi

# Try python3+yaml (most reliable)
if python3 -c "import yaml" 2>/dev/null; then
  python3 -c "
import yaml, sys
path = sys.argv[1]
with open(path) as f: cfg = yaml.safe_load(f) or {}
ctx = cfg.setdefault('context', {})
mem = ctx.setdefault('memory', {})
mem['provider'] = 'noxem'
with open(path, 'w') as f: yaml.dump(cfg, f, default_flow_style=False)
print('✓ Set memory provider to noxem in config.yaml')
" "$HERMES_CONFIG"
elif grep -q "provider: ''" "$HERMES_CONFIG" 2>/dev/null; then
  sed -i "/^ *memory:/,/^[^ ]/{s/provider: ''/provider: noxem/}" "$HERMES_CONFIG" 2>/dev/null
  echo "✓ Set memory provider to noxem in config.yaml (via sed)"
else
  echo "⚠ Could not auto-update config.yaml"
  echo "  Run: hermes memory setup  → Select 'noxem'"
fi

echo ""
echo "Done! Restart hermes-noxem to apply changes."

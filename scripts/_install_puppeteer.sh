#!/bin/bash
# Install puppeteer-core to replace playwright for DeepSProxy
# Requires: bash (WSL / Git Bash / Cygwin on Windows)

# Use correct PATH separator for OS
if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then
    PATH_SEP=":"
else
    PATH_SEP=";"
fi
export PATH="$HOME/.local/bin${PATH_SEP}$HOME/.hermes/node/bin${PATH_SEP}/usr/local/sbin${PATH_SEP}/usr/local/bin${PATH_SEP}/usr/sbin${PATH_SEP}/usr/bin${PATH_SEP}/sbin${PATH_SEP}/bin"

cd "$HOME/.hermes/noxem-server/deepsproxy" || { echo "ERROR: DeepSProxy directory not found"; exit 1; }

echo "=== Installing puppeteer-core@24 ==="
npm install puppeteer-core@24 2>&1 || { echo "ERROR: npm install failed"; exit 1; }

if npm ls playwright > /dev/null 2>&1; then
    echo "=== Uninstalling playwright ==="
    npm uninstall playwright 2>&1 || { echo "WARNING: npm uninstall playwright failed"; }
fi

echo "=== Verifying package.json ==="
if [ -f package.json ]; then
    node -e "const d=require('./package.json'); console.log('puppeteer-core:', d.dependencies?.['puppeteer-core'] || 'NOT FOUND'); console.log('playwright:', d.dependencies?.['playwright'] || 'NOT FOUND')" 2>&1 || echo "WARNING: Could not parse package.json"
else
    echo "WARNING: package.json not found in $(pwd)"
fi

echo "=== Done ==="

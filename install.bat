@echo off
setlocal enabledelayedexpansion

echo === Noxem Memory Provider - Windows Installer ===
echo.

:: Check WSL
wsl -d Ubuntu -e bash -c "exit 0" 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] WSL Ubuntu not found. Install it: wsl --install -d Ubuntu
  pause
  exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "WSL_DIR=%SCRIPT_DIR:\=/%"
set "WSL_DIR=%WSL_DIR:C:=/mnt/c%"
set "WSL_DIR=%WSL_DIR: =\ %"

echo [1/4] Installing memory server deps in WSL...
wsl -d Ubuntu -e bash -c "cd '%WSL_DIR%server' && npm install --no-audit --no-fund"

echo [2/4] Installing Noxem Hermes plugin...
wsl -d Ubuntu -e bash -c "rm -rf $HOME/.hermes/plugins/memory/noxem && mkdir -p $HOME/.hermes/plugins/memory/noxem && cp '%WSL_DIR%plugins/memory/noxem/'* $HOME/.hermes/plugins/memory/noxem/"

echo [3/4] Copying shell hooks...
wsl -d Ubuntu -e bash -c "mkdir -p $HOME/.hermes/agent-hooks && cp '%WSL_DIR%hooks/'*.mjs $HOME/.hermes/agent-hooks/ 2>/dev/null; exit 0"

echo [4/4] Verifying installation...
wsl -d Ubuntu -e bash -c "ls -la $HOME/.hermes/plugins/memory/noxem/ && echo 'Plugin files OK'"

echo.
echo === Installation Complete ===
echo.
echo Next steps:
echo   1. Start the memory server: start.bat
echo   2. Enable in Hermes: hermes memory setup
echo      Select "noxem" from the list
echo   3. Verify: hermes noxem status
echo.
echo Requirements:
echo   - Brain 2: QwenProxy (cloud) OR any local LLM (Ollama, LM Studio, llama.cpp)
echo   - EmbeddingGemma 300M auto-downloads on first start
echo.
pause

@echo off
REM Noxem Launcher — starts both servers, runs Hermes, cleans up on exit.
REM Windows batch file counterpart to noxem-launcher.sh

setlocal enabledelayedexpansion

REM -- Check: noxem must be set as memory provider --
set HERMES_CONFIG=%USERPROFILE%\.hermes\config.yaml
if not exist "%HERMES_CONFIG%" (
  echo.
  echo Error: Hermes config not found at %HERMES_CONFIG%
  echo.
  echo Please run: hermes memory setup
  echo And select 'noxem' as your memory provider.
  echo.
  exit /b 1
)
findstr /R /C:"provider:.*noxem" "%HERMES_CONFIG%" >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo.
  echo Error: Noxem is not set as your memory provider.
  echo.
  echo Please run: hermes memory setup
  echo And select 'noxem' as your memory provider.
  echo.
  exit /b 1
)

REM Config
if not defined MEMORY_PORT set MEMORY_PORT=3001
if not defined LLM_PORT set LLM_PORT=8000
if not defined QWENPROXY_PORT set QWENPROXY_PORT=3000
set MEMORY_SERVER=%~dp0server\memory-server.mjs
set ADAPTER_SERVER=%~dp0server\qwenproxy-adapter.mjs
set QWENPROXY_DIR=%USERPROFILE%\qwenproxy
set QWENPROXY_ENV=%QWENPROXY_DIR%\.env

if not defined ENABLE_EMBEDDING set ENABLE_EMBEDDING=true
if not defined ENABLE_ADVISOR set ENABLE_ADVISOR=true
if not defined ENABLE_MAINTENANCE set ENABLE_MAINTENANCE=true
set NODE_OPTIONS=--dns-result-order=ipv4first

echo.
echo Noxem - Starting Servers
echo.

REM 1. Memory server
echo [1/2] Starting memory server...
echo First run downloads EmbeddingGemma (~300MB)
start /B node "%MEMORY_SERVER%"
set MEMORY_PID=0

echo Waiting for memory server on port %MEMORY_PORT%...
set WAITED=0
set MAX_WAIT=180
:wait_memory
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%MEMORY_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 goto memory_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT% (
  echo TIMEOUT waiting for memory server
  goto :fail
)
timeout /t 1 /nobreak >nul
goto wait_memory
:memory_ready
echo Memory server ready!

REM 2. QwenProxy + Adapter (Brain 2)
echo [2/2] Starting Brain 2 (QwenProxy)...

REM -- Setup QwenProxy if needed --
if not exist "%QWENPROXY_DIR%\node_modules" (
  echo Setting up QwenProxy (first run^)...
  if not exist "%QWENPROXY_DIR%\.git" (
    echo Cloning qwenproxy...
    git clone https://github.com/pedrofariasx/qwenproxy.git "%QWENPROXY_DIR%"
  )
  echo Installing npm dependencies...
  pushd "%QWENPROXY_DIR%"
  npm install --silent
  echo Installing Playwright browsers...
  npx playwright install chromium
  popd
)

REM -- Prompt for credentials if .env doesn't have them --
if not exist "%QWENPROXY_ENV%" goto :prompt_creds
findstr /C:"QWEN_EMAIL=" "%QWENPROXY_ENV%" >nul 2>&1
if %ERRORLEVEL% neq 0 goto :prompt_creds
findstr /C:"QWEN_PASSWORD=" "%QWENPROXY_ENV%" >nul 2>&1
if %ERRORLEVEL% neq 0 goto :prompt_creds
goto :creds_ok

:prompt_creds
echo.
echo QwenProxy needs your Qwen account credentials for automated login.
echo These will be saved to %QWENPROXY_ENV%
echo.
set /p QWEN_EMAIL="Qwen Email: "
set /p QWEN_PASSWORD="Qwen Password: "
if not defined QWEN_EMAIL goto :creds_fail
if not defined QWEN_PASSWORD goto :creds_fail

REM Write .env file
echo PORT=%QWENPROXY_PORT%> "%QWENPROXY_ENV%"
echo QWEN_EMAIL=%QWEN_EMAIL%>> "%QWENPROXY_ENV%"
echo QWEN_PASSWORD=%QWEN_PASSWORD%>> "%QWENPROXY_ENV%"
echo Credentials saved.
goto :creds_ok

:creds_fail
echo Email and password are required. Continuing without Brain 2.
set BRAIN2_ENABLED=0
goto :skip_brain2

:creds_ok
REM Start QwenProxy server
echo Starting QwenProxy server...
pushd "%QWENPROXY_DIR%"
start /B npm start
popd
set QWENPROXY_PID=0

echo Waiting for QwenProxy on port %QWENPROXY_PORT%...
set WAITED=0
set MAX_WAIT_QP=60
:wait_qwenproxy
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%QWENPROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 goto qwenproxy_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT_QP% (
  echo TIMEOUT waiting for QwenProxy
  echo Continuing without Brain 2.
  goto :skip_brain2
)
timeout /t 1 /nobreak >nul
goto wait_qwenproxy
:qwenproxy_ready
echo QwenProxy ready!

REM Start the SSE-to-JSON adapter
echo Starting QwenProxy adapter...
set QWENPROXY_URL=http://127.0.0.1:%QWENPROXY_PORT%
start /B node "%ADAPTER_SERVER%"
set ADAPTER_PID=0

echo Waiting for adapter on port %LLM_PORT%...
set WAITED=0
set MAX_WAIT_ADAPTER=15
:wait_adapter
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%LLM_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 goto adapter_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT_ADAPTER% (
  echo TIMEOUT waiting for adapter
  goto :skip_brain2
)
timeout /t 1 /nobreak >nul
goto wait_adapter
:adapter_ready
echo Adapter ready!

echo.
echo Both servers ready!
echo   Memory server  = http://127.0.0.1:%MEMORY_PORT%
echo   QwenProxy      = http://127.0.0.1:%QWENPROXY_PORT%
echo   Adapter (LLM)  = http://127.0.0.1:%LLM_PORT%
echo.
goto :run_hermes

:skip_brain2
echo Brain 2 skipped.

:run_hermes
if "%~1"=="" (
  echo Launching: hermes chat
  hermes chat
) else (
  echo Launching: hermes %*
  hermes %*
)

echo.
echo Hermes session ended.
goto cleanup

:fail
echo Failed to start servers. Check network connection and try again.
goto cleanup

:cleanup
echo.
echo Shutting down Noxem servers...
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| findstr /i "PID"') do (
  wmic process where "ProcessId=%%a and CommandLine like '%%memory-server%%'" call terminate >nul 2>&1
  wmic process where "ProcessId=%%a and CommandLine like '%%qwenproxy-adapter%%'" call terminate >nul 2>&1
)
echo Memory server stopped
echo Adapter stopped
echo Noxem cleaned up.
endlocal

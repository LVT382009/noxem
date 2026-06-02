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
if not defined QWENPROXY_BROWSER set QWENPROXY_BROWSER=chromium
set MEMORY_SERVER=%~dp0server\memory-server.mjs
set ADAPTER_SERVER=%~dp0server\qwenproxy-adapter.mjs
set QWENPROXY_DIR=%USERPROFILE%\qwenproxy
set QWENPROXY_ENV=%QWENPROXY_DIR%\.env
set NOXEM_CONFIG=%USERPROFILE%\.hermes\noxem.json

if not defined ENABLE_EMBEDDING set ENABLE_EMBEDDING=true
if not defined ENABLE_ADVISOR set ENABLE_ADVISOR=true
if not defined ENABLE_MAINTENANCE set ENABLE_MAINTENANCE=true
if not defined LOG_LEVEL set LOG_LEVEL=quiet
set NODE_OPTIONS=--dns-result-order=ipv4first

REM ── Read saved config from noxem.json ──
if exist "%NOXEM_CONFIG%" (
  REM Simple key extraction (no jq dependency)
  for /f "tokens=2 delims=:," %%a in ('findstr /C:"brain2_provider" "%NOXEM_CONFIG%"') do (
    for /f "tokens=1 delims= " %%b in ("%%a") do (
      set _CFG_PROVIDER=%%~b
      set _CFG_PROVIDER=!_CFG_PROVIDER:"=!
    )
  )
  for /f "tokens=2 delims=:," %%a in ('findstr /C:"llm_url" "%NOXEM_CONFIG%"') do (
    for /f "tokens=1 delims= " %%b in ("%%a") do (
      set _CFG_LLM_URL=%%~b
      set _CFG_LLM_URL=!_CFG_LLM_URL:"=!
    )
  )
  for /f "tokens=2 delims=:," %%a in ('findstr /C:"llm_model" "%NOXEM_CONFIG%"') do (
    for /f "tokens=1 delims= " %%b in ("%%a") do (
      set _CFG_LLM_MODEL=%%~b
      set _CFG_LLM_MODEL=!_CFG_LLM_MODEL:"=!
    )
  )
  for /f "tokens=2 delims=:," %%a in ('findstr /C:"llm_api_key" "%NOXEM_CONFIG%"') do (
    for /f "tokens=1 delims= " %%b in ("%%a") do (
      set _CFG_LLM_API_KEY=%%~b
      set _CFG_LLM_API_KEY=!_CFG_LLM_API_KEY:"=!
    )
  )
  REM Apply saved config (env vars take precedence)
  if not defined BRAIN2_PROVIDER if defined _CFG_PROVIDER set BRAIN2_PROVIDER=!_CFG_PROVIDER!
  if not defined LLM_URL if defined _CFG_LLM_URL set LLM_URL=!_CFG_LLM_URL!
  if not defined LLM_MODEL if defined _CFG_LLM_MODEL set LLM_MODEL=!_CFG_LLM_MODEL!
  if not defined LLM_API_KEY if defined _CFG_LLM_API_KEY set LLM_API_KEY=!_CFG_LLM_API_KEY!
)

REM ── Brain selection ──
echo.
echo Noxem - Brain Selection
echo.
echo  [1] Brain 1 + Brain 2 - full memory + advisor + research
echo  [2] Brain 1 only - memory search only (faster startup)
echo  [3] Quit
echo.
set /p _BRAIN_CHOICE="Choose [1-3]: "
if "%_BRAIN_CHOICE%"=="1" (
  set BRAIN2_ENABLED=1
) else if "%_BRAIN_CHOICE%"=="2" (
  set BRAIN2_ENABLED=0
) else if "%_BRAIN_CHOICE%"=="3" (
  exit /b 0
) else (
  set BRAIN2_ENABLED=0
)

REM ── Brain 2 provider selection ──
if "%BRAIN2_ENABLED%"=="1" if not defined BRAIN2_PROVIDER (
  echo.
  echo Brain 2 - Provider Selection
  echo.
  echo  [1] Qwen 3.6 Plus - free cloud via QwenProxy (requires Qwen account)
  echo  [2] Local model - any OpenAI-compatible LLM (Ollama, LM Studio, llama.cpp...)
  echo  [3] Skip Brain 2 - fall back to Brain 1 only
  echo.
  set /p _PROVIDER_CHOICE="Choose [1-3]: "
  if "!_PROVIDER_CHOICE!"=="1" (
    set BRAIN2_PROVIDER=qwenproxy
  ) else if "!_PROVIDER_CHOICE!"=="2" (
    set BRAIN2_PROVIDER=local
    call :prompt_local_llm
  ) else if "!_PROVIDER_CHOICE!"=="3" (
    set BRAIN2_ENABLED=0
  ) else (
    set BRAIN2_PROVIDER=qwenproxy
  )
)

echo.
if "%BRAIN2_ENABLED%"=="1" (
  if "!BRAIN2_PROVIDER!"=="local" (
    echo Noxem - Starting Servers ^(Local LLM^)
  ) else (
    echo Noxem - Starting Servers ^(Cloud^)
  )
) else (
  echo Noxem - Brain 1 Only
)
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

REM 2. Brain 2
if "%BRAIN2_ENABLED%"=="0" goto :skip_brain2

if "%BRAIN2_PROVIDER%"=="local" goto :start_local_mode
if "%BRAIN2_PROVIDER%"=="freellm" goto :start_local_mode

REM ── QwenProxy mode (cloud) ──
echo [2/2] Starting Brain 2 (QwenProxy)...

REM -- Setup QwenProxy if needed --
if not exist "%QWENPROXY_DIR%\node_modules" (
  echo Setting up QwenProxy (first run^)...
  if not exist "%QWENPROXY_DIR%\.git" (
    echo Cloning qwenproxy...
    git clone https://github.com/LVT382009/noxem-qwenproxy.git "%QWENPROXY_DIR%"
  )
  echo Installing npm dependencies...
  pushd "%QWENPROXY_DIR%"
  npm install --silent
REM Install Playwright browser
dir "%USERPROFILE%\.cache\ms-playwright\%QWENPROXY_BROWSER%-*" >nul 2>&1 && (
    echo Playwright %QWENPROXY_BROWSER% already cached - skipping download
) || (
    echo Installing Playwright browser: %QWENPROXY_BROWSER%
    npx playwright install %QWENPROXY_BROWSER%
)
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
echo BROWSER=%QWENPROXY_BROWSER%>> "%QWENPROXY_ENV%"
echo Credentials saved.
goto :creds_ok

:creds_fail
echo Email and password are required. Continuing without Brain 2.
set BRAIN2_ENABLED=0
goto :skip_brain2

:creds_ok
REM Validate browser name to prevent injection
set _VALID_BROWSER=0
if /I "%QWENPROXY_BROWSER%"=="chromium" set _VALID_BROWSER=1
if /I "%QWENPROXY_BROWSER%"=="chrome" set _VALID_BROWSER=1
if /I "%QWENPROXY_BROWSER%"=="firefox" set _VALID_BROWSER=1
if /I "%QWENPROXY_BROWSER%"=="edge" set _VALID_BROWSER=1
if /I "%QWENPROXY_BROWSER%"=="webkit" set _VALID_BROWSER=1
if %_VALID_BROWSER%==0 (
    echo Warning: Unsupported browser %QWENPROXY_BROWSER%, defaulting to chromium
    set QWENPROXY_BROWSER=chromium
)
REM Upsert BROWSER key into existing .env (for existing installs)
findstr /C:"BROWSER=" "%QWENPROXY_ENV%" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo BROWSER=%QWENPROXY_BROWSER%>> "%QWENPROXY_ENV%"
) else (
    REM Replace existing BROWSER line
    for /f "tokens=1 delims==" %%a in ('findstr /N "BROWSER=" "%QWENPROXY_ENV%"') do (
        powershell -Command "(Get-Content '%QWENPROXY_ENV%') -replace 'BROWSER=.*', 'BROWSER=%QWENPROXY_BROWSER%' | Set-Content '%QWENPROXY_ENV%'" >nul 2>&1
    )
)
echo Starting QwenProxy server...
REM Kill any leftover QwenProxy from a previous session
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%QWENPROXY_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Killing existing process on port %QWENPROXY_PORT%...
  for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%QWENPROXY_PORT% " ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
  )
  timeout /t 2 /nobreak >nul
)
pushd "%QWENPROXY_DIR%"
start /B npm start >nul 2>&1
popd
set QWENPROXY_PID=0

echo Waiting for QwenProxy on port %QWENPROXY_PORT%...
set WAITED=0
set MAX_WAIT_QP=120
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

REM Start the LLM adapter (QwenProxy mode)
echo Starting LLM adapter (QwenProxy mode)...
set QWENPROXY_URL=http://127.0.0.1:%QWENPROXY_PORT%
set BRAIN2_PROVIDER=qwenproxy
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
echo Both servers ready! (QwenProxy/cloud mode)
echo Memory server  = http://127.0.0.1:%MEMORY_PORT%
echo QwenProxy      = http://127.0.0.1:%QWENPROXY_PORT%
echo LLM adapter    = http://127.0.0.1:%LLM_PORT%
echo.
goto :run_hermes

REM ── Local LLM mode ──
:start_local_mode
echo [2/2] Starting Brain 2 (Local model)...

REM Verify local endpoint
if defined LOCAL_LLM_URL (
  curl -s -o nul --connect-timeout 3 "%LOCAL_LLM_URL%/models" >nul 2>&1
  if %ERRORLEVEL%==0 (
    echo Local LLM is reachable at %LOCAL_LLM_URL%
  ) else (
    echo WARNING: Local LLM not reachable at %LOCAL_LLM_URL%
    echo Make sure your LLM server is running.
  )
)

if not defined LOCAL_LLM_URL if defined LLM_URL (
  set LOCAL_LLM_URL=!LLM_URL:/chat/completions=!
)

REM Start the LLM adapter (local passthrough mode)
echo Starting LLM adapter (local mode)...
set BRAIN2_PROVIDER=local
start /B node "%ADAPTER_SERVER%"
set ADAPTER_PID=0

echo Waiting for adapter on port %LLM_PORT%...
set WAITED=0
set MAX_WAIT_ADAPTER=15
:wait_adapter_local
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%LLM_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 goto adapter_local_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT_ADAPTER% (
  echo TIMEOUT waiting for adapter
  goto :skip_brain2
)
timeout /t 1 /nobreak >nul
goto wait_adapter_local
:adapter_local_ready
echo Adapter ready!

echo.
echo Both servers ready! (local mode)
echo Memory server  = http://127.0.0.1:%MEMORY_PORT%
echo LLM adapter    = http://127.0.0.1:%LLM_PORT%
echo Local endpoint = %LOCAL_LLM_URL%
echo Model          = %LLM_MODEL%
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
exit /b


REM ── Subroutine: prompt for FreeLLM (FreeTheAI.xyz) settings ──
:prompt_freellm
echo.
echo ╔══════════════════════════════════════════════╗
echo ║ FreeLLM - FreeTheAI.xyz Free API             ║
echo ╚══════════════════════════════════════════════╝
echo.
echo  Get free LLM access from FreeTheAI.xyz:
echo.
echo   1. Join the Discord: https://discord.gg/hnz3yB3bWg
echo   2. Go to #how-to-signup channel to get your API key
echo   3. Go to #how-to-checkin channel to activate your key
echo   4. Browse models at: https://freetheai.xyz/models/
echo   5. Check model status at: https://freetheai.xyz/status/
echo.
echo  Base URL: https://api.freetheai.xyz/v1 ^(fixed^)
echo.

REM API key (required)
set /p _FREELLM_API_KEY="API key: "
if "!_FREELLM_API_KEY!"=="" (
    echo API key is required for FreeTheAI.xyz
    echo Get one at: https://discord.gg/hnz3yB3bWg -^> #how-to-signup
    set BRAIN2_ENABLED=0
    goto :eof
)

REM Model name
echo.
echo Browse available models: https://freetheai.xyz/models/
echo Check model status: https://freetheai.xyz/status/
set _DEFAULT_FREELLM_MODEL=fee/kimi-k2.6
set /p _FREELLM_MODEL="Model ID [!_DEFAULT_FREELLM_MODEL!]: "
if "!_FREELLM_MODEL!"=="" set _FREELLM_MODEL=!_DEFAULT_FREELLM_MODEL!

REM Context window
set /p _FREELLM_CTX="Context window in tokens [131072]: "
if "!_FREELLM_CTX!"=="" set _FREELLM_CTX=131072

REM Export for adapter and server processes
set LLM_URL=https://api.freetheai.xyz/v1/chat/completions
set LOCAL_LLM_URL=https://api.freetheai.xyz/v1
set LLM_MODEL=!_FREELLM_MODEL!
set LLM_API_KEY=!_FREELLM_API_KEY!
set NOXEM_CONTEXT_WINDOW=!_FREELLM_CTX!
set BRAIN2_PROVIDER=local

echo FreeLLM configured: freetheai.xyz model=!_FREELLM_MODEL! context=!_FREELLM_CTX!
goto :eof

REM ── Subroutine: prompt for local LLM settings ──
:prompt_local_llm
echo.
echo Local LLM Configuration
echo.
echo Enter your local LLM endpoint details.
echo Supported: Ollama, LM Studio, llama.cpp, any OpenAI-compatible API
echo.
echo  Common base URLs:
echo    Ollama:     http://localhost:11434/v1
echo    LM Studio:  http://localhost:1234/v1
echo    llama.cpp:  http://127.0.0.1:8080/v1
echo.

REM Base URL
set _DEFAULT_URL=http://localhost:11434/v1
if defined LLM_URL set _DEFAULT_URL=!LLM_URL:/chat/completions=!
set /p _LOCAL_URL="Base URL [!_DEFAULT_URL!]: "
if "!_LOCAL_URL!"=="" set _LOCAL_URL=!_DEFAULT_URL!

REM Model name
set _DEFAULT_MODEL=gemma4:e4b
if defined LLM_MODEL set _DEFAULT_MODEL=!LLM_MODEL!
set /p _LOCAL_MODEL="Model name [!_DEFAULT_MODEL!]: "
if "!_LOCAL_MODEL!"=="" set _LOCAL_MODEL=!_DEFAULT_MODEL!

REM API key (optional)
echo.
echo  API key is optional - not needed for Ollama or llama.cpp
set /p _LOCAL_API_KEY="API key (press Enter to skip): "

REM Export for adapter and server processes
set LLM_URL=!_LOCAL_URL!/chat/completions
set LOCAL_LLM_URL=!_LOCAL_URL!
set LLM_MODEL=!_LOCAL_MODEL!
set BRAIN2_PROVIDER=local
if not "!_LOCAL_API_KEY!"=="" set LLM_API_KEY=!_LOCAL_API_KEY!

echo Local LLM configured: !_LOCAL_URL! model=!_LOCAL_MODEL!
goto :eof

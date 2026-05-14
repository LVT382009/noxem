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
    echo Please run:  hermes memory setup
    echo And select 'noxem' as your memory provider.
    echo.
    exit /b 1
)
findstr /R /C:"provider:.*noxem" "%HERMES_CONFIG%" >nul 2>&1
if %ERRORLEVEL% neq 0 (
        echo.
        echo Error: Noxem is not set as your memory provider.
        echo.
        echo Please run:  hermes memory setup
        echo And select 'noxem' as your memory provider.
        echo.
        exit /b 1
    )
REM Provider check passed

REM Config
if not defined MEMORY_PORT set MEMORY_PORT=3001
if not defined GEMMA4_PORT set GEMMA4_PORT=8000
set MEMORY_SERVER=%~dp0server\memory-server.mjs
set GEMMA4_SERVER=%~dp0server\gemma4-server.mjs

REM Enable embedding + advisor + maintenance by default
if not defined ENABLE_EMBEDDING set ENABLE_EMBEDDING=true
if not defined ENABLE_ADVISOR set ENABLE_ADVISOR=true
if not defined ENABLE_MAINTENANCE set ENABLE_MAINTENANCE=true

REM Prefer IPv4 for HuggingFace CDN downloads
set NODE_OPTIONS=--dns-result-order=ipv4first

echo.
echo  Noxem - Starting Servers
echo.

REM 1. Memory server
echo [1/2] Starting memory server...
echo   First run downloads EmbeddingGemma (~300MB)
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
    echo   TIMEOUT waiting for memory server
    goto :fail
)
timeout /t 1 /nobreak >nul
goto wait_memory
:memory_ready
echo   Memory server ready!

REM 2. Gemma 4 server
echo [2/2] Starting Gemma 4 server...
echo   First run downloads model (~2GB, subsequent starts use cache)
start /B node "%GEMMA4_SERVER%"
set GEMMA4_PID=0

echo Waiting for Gemma 4 server on port %GEMMA4_PORT%...
set WAITED=0
set MAX_WAIT_GEMMA=300
:wait_gemma4
curl -s -o nul --connect-timeout 1 http://127.0.0.1:%GEMMA4_PORT%/health >nul 2>&1
if %ERRORLEVEL%==0 goto gemma4_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT_GEMMA% (
    echo   TIMEOUT waiting for Gemma 4 server
    goto fail_gemma4
)
timeout /t 1 /nobreak >nul
goto wait_gemma4
:gemma4_ready
echo   Gemma 4 ready!

echo.
echo  Both servers ready!
echo.

REM Run Hermes
if "%~1"=="" (
    echo Launching: hermes chat
    hermes chat
) else (
    echo Launching: hermes %*
    hermes %*
)

echo.
echo  Hermes session ended.
goto cleanup

:fail_gemma4
echo  Gemma 4 server failed to start. Advisor will use fallback mode.
echo  Memory server is still running at http://127.0.0.1:%MEMORY_PORT%
echo  You can continue without Gemma 4.
if "%~1"=="" (
    hermes chat
) else (
    hermes %*
)
goto cleanup

:fail
echo  Failed to start servers. Check network connection and try again.
goto cleanup

:cleanup
echo.
echo  Shutting down Noxem servers...
REM Kill node processes running our servers
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| findstr /i "PID"') do (
    wmic process where "ProcessId=%%a and CommandLine like '%%memory-server%%'" call terminate >nul 2>&1
    wmic process where "ProcessId=%%a and CommandLine like '%%gemma4-server%%'" call terminate >nul 2>&1
)
echo  Memory server stopped
echo  Gemma 4 stopped
echo  Noxem cleaned up.
endlocal

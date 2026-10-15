@echo off
REM Start Edge with CDP enabled for QA agent testing
REM Run this BEFORE using any testing agent

set "EDGE_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" set "EDGE_EXE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" (
  echo [CDP] ERROR: Edge executable not found.
  exit /b 1
)

set "CDP_PROFILE=%LOCALAPPDATA%\Microsoft\Edge\User Data QA-Brain-CDP"

echo [CDP] Starting Microsoft Edge with remote debugging on port 9222...
echo [CDP] Profile: %CDP_PROFILE%
start "" "%EDGE_EXE%" --remote-debugging-port=9222 --user-data-dir="%CDP_PROFILE%" about:blank

set "CDP_OK=0"
for /L %%I in (1,1,20) do (
  powershell -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://localhost:9222/json/version' -TimeoutSec 2 > $null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 (
    set "CDP_OK=1"
    goto :ready
  )
  timeout /t 1 /nobreak >nul
)

:ready
if "%CDP_OK%"=="1" (
  echo [CDP] Ready at http://localhost:9222/json/version
  exit /b 0
)

echo [CDP] ERROR: Endpoint did not come up in time.
echo [CDP] Try: npm run cdp:start
exit /b 1

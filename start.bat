@echo off
REM switch console to UTF-8 so the app's own (Chinese) log output renders correctly.
REM this line is pure ASCII, so it is safe regardless of the OEM codepage.
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================================================
REM  fine - relay balance monitor  ::  local quick start
REM  Usage: double-click this file, or run
REM      start.bat [--rebuild] [--port 3000]
REM    --rebuild   force a fresh production build (default: reuse existing)
REM    --port N    listen on port N (default 3000)
REM  Stop: press Ctrl+C in this window
REM
REM  NOTE: this file is intentionally ASCII-only. cmd.exe parses .bat files using
REM  the OEM codepage (936 on zh-CN Windows); a UTF-8 file with Chinese text gets
REM  mangled and the script breaks. Chinese docs live in README.md.
REM ============================================================================

set "PORT=3000"
set "FORCE_REBUILD=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--rebuild" set "FORCE_REBUILD=1"
if /i "%~1"=="--port" (
  set "PORT=%~2"
  shift
)
shift
goto parse_args
:args_done

echo.
echo   ==========================================================
echo     fine - relay balance monitor   local quick start
echo   ==========================================================
echo.

REM ---- 1/5 Node.js ----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] node not found. Install Node.js 22.5+ : https://nodejs.org/
  goto :fail
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
set "NODE_VER=!NODE_VER:v=!"
for /f "tokens=1,2 delims=." %%a in ("!NODE_VER!") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
set /a NODE_OK=0
if !NODE_MAJOR! GTR 22 set /a NODE_OK=1
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! GEQ 5 set /a NODE_OK=1
if !NODE_OK! EQU 0 (
  echo   [ERROR] Node.js too old: v!NODE_VER! - need 22.5+ ^(built-in node:sqlite^)
  goto :fail
)
echo   [1/5] Node.js v!NODE_VER!  OK

REM ---- 2/5 dependencies -----------------------------------------------------
if not exist "node_modules\next\package.json" (
  echo   [2/5] first run - installing dependencies ^(npm install, may take a while^)...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo   [2/5] dependencies ready
)

REM ---- 3/5 database (idempotent) --------------------------------------------
echo   [3/5] init database ^(npm run db:migrate^)...
call npm run db:migrate
if errorlevel 1 goto :fail

REM ---- 4/5 build ------------------------------------------------------------
if "%FORCE_REBUILD%"=="1" (
  echo   [4/5] force rebuild - cleaning .next ...
  if exist ".next" rmdir /s /q ".next"
)
if not exist ".next\BUILD_ID" (
  echo   [4/5] first build ^(about 30-60s, please wait^)...
  call npm run build
  if errorlevel 1 goto :fail
) else (
  echo   [4/5] existing build found ^(use --rebuild to force^)
)

REM ---- port check -----------------------------------------------------------
netstat -ano | findstr /r /c:":!PORT! .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   [WARN] port !PORT! is already in use.
  echo          Maybe the app is already running; or use: start.bat --port 3001
  echo.
  choice /c YN /m "  Continue anyway"
  if errorlevel 2 goto :fail
)

REM ---- 5/5 start ------------------------------------------------------------
echo.
echo   [5/5] starting on http://localhost:!PORT!
echo   ----------------------------------------------------------
echo     login: admin / admin123
echo     change the default password in Settings after login
echo     stop:  Ctrl+C in this window
echo   ----------------------------------------------------------
echo.

REM open the browser 3s later (powershell avoids cmd quote nesting)
if not defined NOBROWSER (
  start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:!PORT!/login'"
)

call npm start
echo.
echo   server stopped.
pause
goto :eof

:fail
echo.
echo   ----------------------------------------------------------
echo   startup failed - check the error above.
echo   common causes:
echo     - Node.js too old (need 22.5+)
echo     - npm install / npm run build failed (network or deps)
echo     - port already in use
echo   ----------------------------------------------------------
echo.
pause
exit /b 1

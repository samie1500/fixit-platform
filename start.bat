@echo off
title Fixit - Home Repair & Service Platform
cd /d "%~dp0"
echo =========================================================
echo    Fixit - Home Repair & Service Booking Platform
echo =========================================================
echo.

set NODE_EXEC=
where agy-node >nul 2>nul
if %errorlevel%==0 set NODE_EXEC=agy-node

if not defined NODE_EXEC (
  where node >nul 2>nul
  if %errorlevel%==0 set NODE_EXEC=node
)

if not defined NODE_EXEC (
  if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" set NODE_EXEC="%APPDATA%\Antigravity\bin\agy-node.cmd"
)

if not defined NODE_EXEC (
  if exist "%LOCALAPPDATA%\Programs\node\node.exe" set NODE_EXEC="%LOCALAPPDATA%\Programs\node\node.exe"
)

if not defined NODE_EXEC (
  echo [ERROR] Neither 'agy-node' nor 'node' executable could be found in PATH.
  echo Please make sure Node.js or Antigravity runtime is available.
  pause
  exit /b 1
)

echo [INFO] Starting backend server using: %NODE_EXEC%
echo [INFO] Platform URL: http://localhost:3000
echo.
%NODE_EXEC% server.js
pause

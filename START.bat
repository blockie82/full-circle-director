@echo off
title Full Circle Immersive server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js isn't installed on this PC.
  echo  Download the LTS version from https://nodejs.org, install it, then double-click START.bat again.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\ws" (
  echo Installing the server's components for the first time...
  call npm install --omit=dev
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080"
node server.js
echo.
echo The server has stopped.
pause

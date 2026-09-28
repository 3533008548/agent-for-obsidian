@echo off
rem Double-click launcher: no terminal typing needed.
rem Keep this file next to package.json.
cd /d "%~dp0"

if exist "dist\main.cjs" goto run

echo First launch: building the app, this takes a moment...
call npm.cmd run build
if errorlevel 1 (
  echo Build failed. Run "npm.cmd run build" in a terminal to see why.
  pause
  exit /b 1
)

:run
rem "start" releases this window instead of leaving a black console behind.
start "" "node_modules\electron\dist\electron.exe" .

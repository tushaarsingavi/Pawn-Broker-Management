@echo off
title Gold Loan Manager
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and install it, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing required packages, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. Check your internet connection and try again. & pause & exit /b 1 )
)
start "" http://localhost:3000
echo Gold Loan Manager is starting. Keep this window open while you use the system.
echo Close this window to stop it.
node --no-warnings server/index.js
pause

@echo off
setlocal
if not exist node_modules (
  echo [wrightyard] Installing dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
if not exist dist\index.js (
  echo [wrightyard] Building the bot...
  call npm run build
  if errorlevel 1 exit /b 1
)
node dist\index.js

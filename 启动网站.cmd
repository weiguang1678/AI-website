@echo off
rem ---------------------------------------------------------------
rem  IMPORTANT: keep this file pure ASCII.
rem  cmd.exe parses .bat/.cmd using the system OEM code page (936 on
rem  a Chinese Windows), NOT UTF-8. Non-ASCII bytes get mis-decoded,
rem  can swallow the following newline, and break the whole script.
rem  chcp 65001 only changes console OUTPUT encoding, not parsing.
rem  All Chinese text lives in tools\launcher.mjs instead.
rem ---------------------------------------------------------------
chcp 65001 >nul
title AI Website Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install it from https://nodejs.org first.
  echo.
  pause
  exit /b 1
)

node "tools\launcher.mjs"

echo.
pause

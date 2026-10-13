@echo off
rem Keep this file pure ASCII - cmd.exe parses batch files with the
rem system OEM code page, not UTF-8. See tools\launcher.mjs for details.
chcp 65001 >nul
title AI Website - server only
cd /d "%~dp0"
node server.js
echo.
pause

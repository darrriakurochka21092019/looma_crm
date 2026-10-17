@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if not "%errorlevel%"=="0" goto node_missing
node scripts/start-ready.mjs
if not "%errorlevel%"=="0" goto failed
exit /b 0
:node_missing
echo Install Node.js 24, then open this file again.
:failed
echo LOOMA did not start. Read the error above.
pause
exit /b 1

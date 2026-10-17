@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS, then run this file again.
  pause
  exit /b 1
)
node scripts/setup.mjs
if not exist storage mkdir storage
if not exist backups mkdir backups
docker compose up -d --build
if errorlevel 1 (
  echo Docker Compose did not start. See README.md for the PostgreSQL without Docker option.
  pause
  exit /b 1
)
docker compose exec app node dist/server/seed.js
if errorlevel 1 (
  echo Could not create the owner account. See docker compose logs app
  pause
  exit /b 1
)
echo LOOMA.CRM: http://localhost:3001
echo Login: owner@looma.local
echo Password: SEED_PASSWORD in the .env file
start http://localhost:3001
pause

@echo off
cd /d "%~dp0"
node scripts/setup.mjs
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
echo Configure DATABASE_URL in .env for your local PostgreSQL first.
call npm run db:seed
if errorlevel 1 (
 echo Database connection failed. Edit DATABASE_URL in .env.
 pause
 exit /b 1
)
call npm run build
if errorlevel 1 exit /b 1
start http://localhost:3001
call npm start
pause

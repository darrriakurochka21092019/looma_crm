@echo off
setlocal
cd /d "%~dp0"
node scripts/setup.mjs
if not "%errorlevel%"=="0" goto failed
node -e "for(const n of ['tsx','vite','typescript','pg','argon2'])require.resolve(n)" >nul 2>nul
if "%errorlevel%"=="0" goto seed
call npm ci
if not "%errorlevel%"=="0" goto install_failed
:seed
echo Configure DATABASE_URL in .env for your local PostgreSQL first.
call npm run db:seed
if not "%errorlevel%"=="0" goto seed_failed
call npm run build
if not "%errorlevel%"=="0" goto failed
echo Open http://localhost:3001 after the server starts. Keep this window open.
call npm start
if not "%errorlevel%"=="0" goto failed
exit /b 0
:install_failed
echo Dependency installation failed. See npm errors above. Database setup was not started.
goto failed
:seed_failed
echo Database initialization failed. See the actual error above; check DATABASE_URL if it is a connection error.
:failed
pause
exit /b 1

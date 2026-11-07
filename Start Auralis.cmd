@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo Build the studio first: npm ci then npm run build
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4173/ in your browser. Close this window to stop.
where node >nul 2>nul
if not errorlevel 1 (
  node "scripts\serve.mjs"
  exit /b
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m http.server 4173 --bind 127.0.0.1 --directory dist
  exit /b
)
echo Install Node.js or Python to serve this local app.
pause

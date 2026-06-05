@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  ANPR + speed pipeline — one-click run (Windows)
REM  - Installs Python dependencies
REM  - Optionally starts XAMPP MySQL + Apache (edit path if yours differs)
REM  - Launches main.py (pass flags through: deploy.cmd --pick)
REM ---------------------------------------------------------------------------

set "REPO=%CD%"
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo [deploy] ERROR: No Python found. Install Python 3.11+ and retry.
  exit /b 1
)

echo [deploy] Python: %PY%
echo [deploy] Repo:   %REPO%

echo [deploy] pip install -r requirements.txt ...
%PY% -m pip install -r "%REPO%\requirements.txt" --disable-pip-version-check -q
if errorlevel 1 (
  echo [deploy] pip failed.
  exit /b 1
)

REM --- XAMPP (optional): comment out if you start services manually ------------
set "XAMPP=C:\xampp"
if exist "%XAMPP%\mysql_start.bat" (
  echo [deploy] Starting XAMPP MySQL + Apache ...
  start "" /MIN "%XAMPP%\mysql_start.bat"
  timeout /t 2 /nobreak >nul
)
if exist "%XAMPP%\apache_start.bat" (
  start "" /MIN "%XAMPP%\apache_start.bat"
  timeout /t 2 /nobreak >nul
)

REM --- Clear dev-only env vars from earlier sessions ---------------------------
set "HEADLESS="
set "MAX_FRAMES="

echo [deploy] Starting application...
pushd "%REPO%"
%PY% main.py %*
set "EC=%ERRORLEVEL%"
popd

if not "%EC%"=="0" echo [deploy] Exit code %EC%
exit /b %EC%

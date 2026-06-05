@echo off
setlocal enabledelayedexpansion
title CarTrack Pro - Deploying...

:: =========================================================================
::  CarTrack Pro - One-Click Local Launcher
::  Starts: Backend (FastAPI :8001)  +  Frontend (Vite :5173)
::  Database: SQLite - zero config, auto-created on first run
:: =========================================================================

:: Locate project root from this file's own location
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "VENV=%BACKEND%\venv"
set "VPYTHON=%VENV%\Scripts\python.exe"
set "VPIP=%VENV%\Scripts\pip.exe"
set "BACKEND_PORT=8001"
set "FRONTEND_PORT=5173"

echo.
echo +----------------------------------------------------------+
echo ^|   CarTrack Pro - AI Car Tracking System                  ^|
echo ^|   Backend  : http://localhost:8001                       ^|
echo ^|   Frontend : http://localhost:5173                       ^|
echo ^|   Vercel+HTTPS: scripts\deploy-all.ps1                   ^|
echo +----------------------------------------------------------+
echo.

:: =========================================================================
:: [1/6] Python
:: =========================================================================
echo [1/6] Checking Python...
where python >nul 2>&1
if errorlevel 1 goto noPython
echo        Python found.
goto checkNode

:noPython
echo.
echo ERROR: Python not found in PATH.
echo        Download from https://python.org
echo        During install tick "Add Python to PATH".
echo.
pause
exit /b 1

:: =========================================================================
:: [2/6] Node.js
:: =========================================================================
:checkNode
echo [2/6] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 goto noNode
echo        Node.js found.
goto checkEnv

:noNode
echo.
echo ERROR: Node.js not found in PATH.
echo        Download LTS from https://nodejs.org
echo.
pause
exit /b 1

:: =========================================================================
:: [3/6] Environment files
:: =========================================================================
:checkEnv
echo [3/6] Checking environment files...

if exist "%BACKEND%\.env" goto backendEnvOk
echo        Creating backend\.env with defaults...
echo DATABASE_URL=sqlite:///./cartrack.db>  "%BACKEND%\.env"
echo SECRET_KEY=cartrack-dev-secret-32chars-change-in-prod>> "%BACKEND%\.env"
echo ALGORITHM=HS256>> "%BACKEND%\.env"
echo ACCESS_TOKEN_EXPIRE_MINUTES=480>> "%BACKEND%\.env"
echo APP_NAME=CarTrack Pro>> "%BACKEND%\.env"
echo APP_VERSION=1.0.0>> "%BACKEND%\.env"
echo DEBUG=true>> "%BACKEND%\.env"
echo ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173>> "%BACKEND%\.env"
echo USE_GPU=false>> "%BACKEND%\.env"
echo AI_CONFIDENCE_THRESHOLD=0.7>> "%BACKEND%\.env"
echo        backend\.env created.
goto frontendEnvCheck

:backendEnvOk
echo        backend\.env OK.

:frontendEnvCheck
if exist "%FRONTEND%\.env" goto frontendEnvOk
echo VITE_API_URL=http://localhost:%BACKEND_PORT%> "%FRONTEND%\.env"
echo        frontend\.env created.
goto setupPython

:frontendEnvOk
echo        frontend\.env OK.

:: =========================================================================
:: [4/6] Python virtual environment + packages
:: =========================================================================
:setupPython
echo [4/6] Setting up Python environment...

if exist "%VPYTHON%" goto pipInstall
echo        Creating virtual environment...

:: Python 3.13 fix: use --without-scm-ignore-files to avoid C:\ permission error.
:: If flag is not recognised on older Python, fall back to plain venv.
python -m venv --without-scm-ignore-files "%VENV%" >nul 2>&1
if not errorlevel 1 goto venvCreated
python -m venv "%VENV%" >nul 2>&1
if not errorlevel 1 goto venvCreated

echo.
echo ERROR: Failed to create Python virtual environment.
echo        Try running as Administrator, or create it manually:
echo          python -m venv "%VENV%"
echo.
pause
exit /b 1

:venvCreated
echo        Virtual environment created.

:pipInstall
echo        Installing Python packages (first run takes a few minutes)...
"%VPYTHON%" -m pip install --upgrade pip --disable-pip-version-check
:: --prefer-binary avoids building from source (no Rust/C compiler needed on Windows)
"%VPYTHON%" -m pip install -r "%BACKEND%\requirements.txt" --prefer-binary
if not errorlevel 1 goto paddleInstall

:: Fallback: psycopg2 needs PostgreSQL headers - skip it (SQLite is used by default)
echo        A package failed. Retrying without optional PostgreSQL driver...
"%VPYTHON%" -m pip install fastapi "uvicorn[standard]" python-multipart sqlalchemy alembic aiosqlite "python-jose[cryptography]" bcrypt python-dotenv pydantic pydantic-settings email-validator aiofiles "pillow>=10.4.0" httpx websockets opencv-python-headless "numpy>=1.26.4" easyocr ultralytics huggingface_hub pandas openpyxl pytz slowapi --prefer-binary
if not errorlevel 1 goto paddleInstall

echo.
echo ERROR: pip install failed. Check your internet connection, then run:
echo          cd backend
echo          pip install -r requirements.txt --prefer-binary
echo.
pause
exit /b 1

:paddleInstall
echo        Core packages ready.
echo        Trying PaddleOCR upgrade (optional - 3-5x faster OCR)...
echo        This downloads ~200 MB on first install. Press Ctrl+C to skip.
"%VPYTHON%" -m pip install paddlepaddle paddleocr --prefer-binary --timeout 120
if errorlevel 1 (
    echo        PaddleOCR skipped - EasyOCR will be used instead.
) else (
    echo        PaddleOCR installed - OCR is now 3-5x faster!
)

:pythonReady
echo        Python packages ready.

:: =========================================================================
:: [5/6] Node / npm packages
:: =========================================================================
:setupNode
echo [5/6] Setting up Node packages...

if exist "%FRONTEND%\node_modules" goto nodeReady
echo        Running npm install - one-time setup, about 2 minutes...
pushd "%FRONTEND%"
call npm install --loglevel=error
set NPM_EC=%ERRORLEVEL%
popd
if %NPM_EC% EQU 0 goto nodeReady

echo.
echo ERROR: npm install failed. Check your internet connection, then run:
echo          cd frontend
echo          npm install
echo.
pause
exit /b 1

:nodeReady
echo        Node packages ready.

:: =========================================================================
:: [6/6] Free ports
:: =========================================================================
:freePorts
echo [6/6] Releasing ports %BACKEND_PORT% and %FRONTEND_PORT%...
:: uvicorn --reload can leave orphan workers on Windows that still serve old API routes
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'spawn_main\(parent_pid=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
for /L %%n in (1,1,5) do (
    for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
        taskkill /PID %%p /F >nul 2>&1
    )
    for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%FRONTEND_PORT% " ^| findstr "LISTENING"') do (
        taskkill /PID %%p /F >nul 2>&1
    )
    ping -n 2 127.0.0.1 >nul 2>&1
)
echo        Ports cleared.
echo.

:: =========================================================================
:: Write launcher .bat files - avoids ALL nested-quote / space-in-path bugs
:: =========================================================================
set "BL=%TEMP%\cartrack_backend.bat"
set "FL=%TEMP%\cartrack_frontend.bat"

echo @echo off>  "%BL%"
echo color 0A>> "%BL%"
echo title CarTrack Backend :8001>> "%BL%"
echo cd /d "%BACKEND%">> "%BL%"
echo "%VPYTHON%" -m uvicorn app.main:app --host 0.0.0.0 --port %BACKEND_PORT% --reload --reload-dir app>> "%BL%"
echo pause>> "%BL%"

echo @echo off>  "%FL%"
echo color 09>> "%FL%"
echo title CarTrack Frontend :5173>> "%FL%"
echo cd /d "%FRONTEND%">> "%FL%"
echo call npm run dev>> "%FL%"
echo pause>> "%FL%"

:: =========================================================================
:: Launch Backend
:: =========================================================================
echo Starting Backend  (green window)...
start "CarTrack-Backend" cmd /k "%BL%"

:: Poll /api/ready until OCR + YOLO warm-up finished (blocking startup in FastAPI lifespan)
echo Waiting for backend + AI engines (OCR + YOLO)…
set TRIES=0
:waitBackend
set /a TRIES=TRIES+1
if %TRIES% GTR 180 goto backendSlow
ping -n 2 127.0.0.1 >nul 2>&1
curl -sf --max-time 2 http://localhost:%BACKEND_PORT%/api/ready >nul 2>&1
if %ERRORLEVEL% EQU 0 goto backendReady
goto waitBackend

:backendSlow
echo Backend or AI models are taking longer than expected.
echo First run: EasyOCR/Paddle + YOLO downloads can take several minutes.
echo Waiting an extra 60 seconds for /api/ready…
set TRIES=0
:waitBackendExtra
set /a TRIES=TRIES+1
if %TRIES% GTR 60 goto launchFrontend
ping -n 2 127.0.0.1 >nul 2>&1
curl -sf --max-time 2 http://localhost:%BACKEND_PORT%/api/ready >nul 2>&1
if %ERRORLEVEL% EQU 0 goto backendReady
goto waitBackendExtra

:backendReady
echo        Backend ready — OCR + YOLO loaded (live + video test ready immediately).
echo        Verifying Dahua camera API...
curl -sf --max-time 3 http://localhost:%BACKEND_PORT%/api/cameras/profiles >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo WARNING: Camera API returned 404 — stale uvicorn worker may still be on port %BACKEND_PORT%.
    echo          Close ALL backend terminal windows, wait 5 seconds, then run deploy.cmd again.
    echo.
) else (
    echo        Camera API OK ^(Dahua Hero A1 settings will load^).
)

:: =========================================================================
:: Launch Frontend
:: =========================================================================
:launchFrontend
echo.
echo Starting Frontend (blue window)...
start "CarTrack-Frontend" cmd /k "%FL%"

:: Poll frontend up to 30 seconds
set TRIES=0
:waitFrontend
set /a TRIES=TRIES+1
if %TRIES% GTR 30 goto openBrowser
ping -n 2 127.0.0.1 >nul 2>&1
curl -s --max-time 1 http://localhost:%FRONTEND_PORT% >nul 2>&1
if %ERRORLEVEL% EQU 0 goto openBrowser
goto waitFrontend

:: =========================================================================
:: Open browser
:: =========================================================================
:openBrowser
timeout /t 2 /nobreak >nul
start "" "http://localhost:%FRONTEND_PORT%"

:: =========================================================================
:: Done
:: =========================================================================
echo.
echo +----------------------------------------------------------+
echo ^|             CarTrack Pro is RUNNING                      ^|
echo +----------------------------------------------------------+
echo ^|  App    : http://localhost:5173                          ^|
echo ^|  API    : http://localhost:8001/api/docs                 ^|
echo ^|  Login  : admin  /  demo1234                            ^|
echo +----------------------------------------------------------+
echo ^|  Green window = Backend  (FastAPI + AI engine)           ^|
echo ^|  Blue window  = Frontend (Vite dev server)               ^|
echo +----------------------------------------------------------+
echo ^|  Deploy waits until /api/ready — both AI engines loaded. ^|
echo ^|  First run: models + OCR can take a few minutes.         ^|
echo ^|  To stop: close both terminal windows.                   ^|
echo +----------------------------------------------------------+
echo.
pause
endlocal

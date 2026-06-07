# Start CarTrack locally - backend + frontend, camera via Dahua Easy4IP cloud (P2P).
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Py = Join-Path $Backend "venv\Scripts\python.exe"

Write-Host "CarTrack local (cloud camera via Easy4IP P2P)" -ForegroundColor Cyan
Write-Host "  Backend  : http://localhost:8001"
Write-Host "  Frontend : http://localhost:5173"
Write-Host ""

# Fix stale LAN RTSP in live session DB
& $Py (Join-Path $Backend "scripts\fix_live_sessions_cloud.py")

# Stop existing backend (8001) and frontend (5173) to avoid 502 proxy / wrong port
foreach ($port in @(8001, 5173)) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$Backend'; Write-Host 'CarTrack API (cloud P2P)' -ForegroundColor Green; .\venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload"
) -WindowStyle Normal

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $h = Invoke-WebRequest -Uri "http://127.0.0.1:8001/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "Backend OK: $($h.Content)" -ForegroundColor Green
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}
if (-not $ready) {
  Write-Host "Backend not ready yet - check the API window (should be up within ~10s)." -ForegroundColor Yellow
}

Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "cd '$Frontend'; Write-Host 'CarTrack UI' -ForegroundColor Green; npm run dev"
) -WindowStyle Normal

Write-Host ""
Write-Host "Open http://localhost:5173" -ForegroundColor Green
Write-Host "Settings -> Camera cloud -> Connect and open live feed" -ForegroundColor Yellow

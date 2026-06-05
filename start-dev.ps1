#!/usr/bin/env pwsh
# CarTrack Pro — Development Startup Script

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         CarTrack Pro — AI Monitoring System      ║" -ForegroundColor Cyan
Write-Host "║               Development Startup                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check PostgreSQL
Write-Host "▶ Checking PostgreSQL..." -ForegroundColor Yellow
$pgRunning = Get-Process postgres -ErrorAction SilentlyContinue
if (-not $pgRunning) {
    Write-Host "  ⚠  PostgreSQL is not running. Start it or use Docker:" -ForegroundColor Yellow
    Write-Host "     docker-compose up db redis -d" -ForegroundColor Gray
    Write-Host ""
}

# Backend
Write-Host "▶ Starting Backend (FastAPI)..." -ForegroundColor Green
$backendJob = Start-Job -ScriptBlock {
    Set-Location "$using:PSScriptRoot\backend"
    if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
    python -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload --reload-dir app
}
Write-Host "  ✓ Backend starting on http://localhost:8001" -ForegroundColor Green
Write-Host "  ✓ API Docs: http://localhost:8001/api/docs" -ForegroundColor Gray

Start-Sleep -Seconds 3

# Frontend
Write-Host ""
Write-Host "▶ Starting Frontend (React + Vite)..." -ForegroundColor Blue
$frontendJob = Start-Job -ScriptBlock {
    Set-Location "$using:PSScriptRoot\frontend"
    npm run dev
}
Write-Host "  ✓ Frontend starting on http://localhost:5173" -ForegroundColor Blue

Write-Host ""
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Gray
Write-Host "  Dashboard:  http://localhost:5173" -ForegroundColor White
Write-Host "  API:        http://localhost:8001" -ForegroundColor White
Write-Host "  API Docs:   http://localhost:8001/api/docs" -ForegroundColor White
Write-Host ""
Write-Host "  Default login: admin / Admin@1234" -ForegroundColor Yellow
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop all services" -ForegroundColor Gray

try {
    Wait-Job $backendJob, $frontendJob
} finally {
    Stop-Job $backendJob, $frontendJob
    Remove-Job $backendJob, $frontendJob
}

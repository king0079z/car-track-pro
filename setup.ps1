#!/usr/bin/env pwsh
# CarTrack Pro — First-Time Setup Script

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         CarTrack Pro — Initial Setup             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$Root = $PSScriptRoot

# ── Python Check ──────────────────────────────────────────────────────
Write-Host "▶ Checking Python..." -ForegroundColor Yellow
$python = python --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Python not found. Please install Python 3.11+" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ $python" -ForegroundColor Green

# ── Node Check ────────────────────────────────────────────────────────
Write-Host "▶ Checking Node.js..." -ForegroundColor Yellow
$node = node --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Node.js not found. Please install Node.js 18+" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Node $node" -ForegroundColor Green

# ── Backend Setup ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Setting up Backend..." -ForegroundColor Yellow
Set-Location "$Root\backend"

if (-not (Test-Path "venv")) {
    Write-Host "  Creating virtual environment..." -ForegroundColor Gray
    python -m venv venv
}

Write-Host "  Installing Python packages..." -ForegroundColor Gray
& ".\venv\Scripts\pip.exe" install -r requirements.txt --quiet

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "  ✓ Created .env from template — please configure DATABASE_URL" -ForegroundColor Yellow
}

Write-Host "  ✓ Backend ready" -ForegroundColor Green

# ── Frontend Setup ────────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Setting up Frontend..." -ForegroundColor Yellow
Set-Location "$Root\frontend"

Write-Host "  Installing npm packages..." -ForegroundColor Gray
npm install --silent

Write-Host "  ✓ Frontend ready" -ForegroundColor Green

# ── Done ──────────────────────────────────────────────────────────────
Set-Location $Root
Write-Host ""
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✅ Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Start PostgreSQL (or: docker-compose up db redis -d)" -ForegroundColor Gray
Write-Host "  2. Edit backend\.env and set DATABASE_URL" -ForegroundColor Gray
Write-Host "  3. Run: .\start-dev.ps1" -ForegroundColor Gray
Write-Host ""
Write-Host "  Default login: admin / Admin@1234" -ForegroundColor Yellow
Write-Host "══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

# CarTrack — full cloud wiring: HTTPS backend + Vercel frontend
# Run from repo root in PowerShell.

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CarTrack — Deploy ALL (Vercel + API)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Choose backend HTTPS option:" -ForegroundColor Yellow
Write-Host "  [1] Cloudflare Tunnel (free) — backend stays on THIS PC (cameras work on LAN)"
Write-Host "  [2] Render.com (free) — API in cloud (cameras need site relay; see docs)"
Write-Host "  [3] I already have an HTTPS API URL"
Write-Host ""
$choice = Read-Host "Enter 1, 2, or 3"

$apiUrl = ""

switch ($choice) {
    "1" {
        & (Join-Path $Root "scripts\cloudflare-tunnel.ps1")
        $tunnelFile = Join-Path $Root "scripts\.tunnel-url.txt"
        if (Test-Path $tunnelFile) {
            $apiUrl = (Get-Content $tunnelFile -Raw).Trim()
        }
        if (-not $apiUrl) {
            Write-Host "Tunnel URL not captured. Copy the https:// URL from cloudflared output." -ForegroundColor Yellow
            $apiUrl = Read-Host "Paste your Cloudflare tunnel URL (https://...)"
        }
        Write-Host ""
        Write-Host "Keep cloudflared running while you use CarTrack remotely." -ForegroundColor Yellow
        Write-Host "Also run deploy.cmd in another window so the API is up on :8001." -ForegroundColor Yellow
    }
    "2" {
        Write-Host ""
        Write-Host "Render setup:" -ForegroundColor Cyan
        Write-Host "  1. Push this repo to GitHub"
        Write-Host "  2. https://dashboard.render.com → New + → Blueprint"
        Write-Host "  3. Connect repo — Render reads render.yaml"
        Write-Host "  4. After deploy, copy service URL e.g. https://cartrack-api.onrender.com"
        Write-Host "  5. Render → cartrack-api → Environment → set ALLOWED_ORIGINS to your Vercel URL"
        Write-Host ""
        $apiUrl = Read-Host "Paste your Render HTTPS URL (https://cartrack-api.onrender.com)"
    }
    "3" {
        $apiUrl = Read-Host "Paste your HTTPS API base URL"
    }
    default {
        Write-Host "Invalid choice." -ForegroundColor Red
        exit 1
    }
}

$apiUrl = $apiUrl.Trim().TrimEnd("/")
if ($apiUrl -notmatch "^https://") {
    Write-Host "API URL must start with https:// for Vercel (mixed content)." -ForegroundColor Red
    exit 1
}

# Write frontend env for local + Vercel instructions
$feEnv = Join-Path $Frontend ".env.production.local"
@"
VITE_API_URL=$apiUrl
"@ | Set-Content -Path $feEnv -Encoding UTF8
Write-Host "Wrote $feEnv" -ForegroundColor Green

# Backend CORS — append vercel hint
$beEnv = Join-Path $Backend ".env"
$vercelOrigin = Read-Host "Paste your Vercel app URL (https://xxx.vercel.app) or press Enter to skip"
if ($vercelOrigin) {
    $vercelOrigin = $vercelOrigin.Trim().TrimEnd("/")
    if (Test-Path $beEnv) {
        $content = Get-Content $beEnv -Raw
        if ($content -notmatch [regex]::Escape($vercelOrigin)) {
            if ($content -match "ALLOWED_ORIGINS=(.+)") {
                $content = $content -replace "ALLOWED_ORIGINS=(.+)", "ALLOWED_ORIGINS=`$1,$vercelOrigin"
            } else {
                $content += "`nALLOWED_ORIGINS=http://localhost:5173,$vercelOrigin`n"
            }
            Set-Content -Path $beEnv -Value $content.TrimEnd() -Encoding UTF8
            Write-Host "Updated backend ALLOWED_ORIGINS with $vercelOrigin" -ForegroundColor Green
        }
    } else {
        @"
DATABASE_URL=sqlite:///./cartrack.db
SECRET_KEY=cartrack-dev-secret-32chars-change-in-prod
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,$vercelOrigin
DEBUG=true
"@ | Set-Content -Path $beEnv -Encoding UTF8
        Write-Host "Created backend\.env" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Vercel — set Environment Variable:" -ForegroundColor Cyan
Write-Host "  VITE_API_URL = $apiUrl"
Write-Host "  Project: https://vercel.com/mohammed0089-9773s-projects"
Write-Host "  Settings → Environment Variables → Production → Redeploy"
Write-Host ""
Write-Host "Docs: docs\VERCEL.md  docs\DEPLOY-ALL.md  docs\cartrack-cloud-video.md"
Write-Host ""

if (Get-Command vercel -ErrorAction SilentlyContinue) {
    $doVercel = Read-Host "Run 'vercel --prod' from frontend folder now? (y/N)"
    if ($doVercel -eq "y") {
        Push-Location $Frontend
        $env:VITE_API_URL = $apiUrl
        vercel --prod
        Pop-Location
    }
} else {
    Write-Host "Install Vercel CLI for auto deploy: npm i -g vercel" -ForegroundColor Yellow
}

Write-Host "Done." -ForegroundColor Green

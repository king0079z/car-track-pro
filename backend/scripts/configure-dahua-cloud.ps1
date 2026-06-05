# CarTrack — Dahua cloud (Easy4IP / P2P) network + config helper
# Run from PowerShell as Administrator for firewall rules (optional but recommended).

$ErrorActionPreference = "Stop"
$Backend = Split-Path $PSScriptRoot -Parent
$Root = Split-Path $Backend -Parent
$CamerasJson = Join-Path $Backend "cameras.json"

Write-Host "CarTrack Dahua cloud configuration" -ForegroundColor Cyan
Write-Host "Backend: $Backend"

# Outbound UDP helps STUN hole-punch (same as DMSS cloud video).
$python = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue)?.Source }
if ($python -and ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $ruleName = "CarTrack Dahua P2P UDP Out"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Allow -Protocol UDP -Program $python | Out-Null
        Write-Host "Added firewall rule: $ruleName" -ForegroundColor Green
    } else {
        Write-Host "Firewall rule already present: $ruleName" -ForegroundColor Yellow
    }
} else {
    Write-Host "Tip: Re-run this script as Administrator to allow outbound UDP for Python (cloud STUN)." -ForegroundColor Yellow
}

if (Test-Path $CamerasJson) {
    $cfg = Get-Content $CamerasJson -Raw | ConvertFrom-Json
    $d = $cfg.dahua_hero_a1
    Write-Host "`nCurrent cameras.json:" -ForegroundColor Cyan
    Write-Host "  connection_mode: $($d.connection_mode)"
    Write-Host "  device_serial:   $($d.device_serial)"
    Write-Host "  host (LAN):      $($d.host)"
    Write-Host "  enabled:         $($d.enabled)"
    if ($d.connection_mode -ne "p2p") {
        Write-Host "  -> Set connection_mode to p2p in Settings or edit cameras.json" -ForegroundColor Yellow
    }
} else {
    Write-Host "cameras.json not found at $CamerasJson" -ForegroundColor Red
}

Write-Host "`nRunning cloud tunnel test (may take up to 3 min)..." -ForegroundColor Cyan
Set-Location $Backend
python -m scripts.test_p2p_quick
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nDone. Restart the CarTrack backend, then Settings -> Start cloud tunnel." -ForegroundColor Green

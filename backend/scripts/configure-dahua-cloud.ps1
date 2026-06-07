# CarTrack - Dahua cloud (Easy4IP / P2P) network + config helper
# Run from PowerShell as Administrator for firewall rules (optional but recommended).
#
# Usage (Admin PowerShell):
#   cd "c:\Users\Mohamed\Desktop\Car Tracking system\backend\scripts"
#   .\configure-dahua-cloud.ps1

$ErrorActionPreference = "Stop"
$Backend = Split-Path $PSScriptRoot -Parent
$CamerasJson = Join-Path $Backend "cameras.json"
$Py = Join-Path $Backend "venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) {
        $Py = $cmd.Source
    } else {
        $cmd = Get-Command py -ErrorAction SilentlyContinue
        if ($cmd) {
            $Py = $cmd.Source
        }
    }
}

Write-Host "CarTrack Dahua cloud configuration" -ForegroundColor Cyan
Write-Host "Backend: $Backend"
Write-Host "Python:  $Py"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Py -and (Test-IsAdministrator)) {
    $ruleName = "CarTrack Dahua P2P UDP Out"
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Allow -Protocol UDP -Program $Py | Out-Null
        Write-Host "Added firewall rule: $ruleName" -ForegroundColor Green
    } else {
        Write-Host "Firewall rule already present: $ruleName" -ForegroundColor Yellow
    }
} else {
    if (-not (Test-IsAdministrator)) {
        Write-Host "Tip: Re-run this script as Administrator to allow outbound UDP for Python (cloud STUN)." -ForegroundColor Yellow
    }
    if (-not $Py) {
        Write-Host "Warning: Python not found - skipping firewall rule." -ForegroundColor Yellow
    }
}

if (Test-Path $CamerasJson) {
    $cfg = Get-Content $CamerasJson -Raw | ConvertFrom-Json
    $d = $cfg.dahua_hero_a1
    Write-Host ""
    Write-Host "Current cameras.json:" -ForegroundColor Cyan
    Write-Host "  connection_mode: $($d.connection_mode)"
    Write-Host "  device_serial:   $($d.device_serial)"
    Write-Host "  host (LAN):      $($d.host)"
    Write-Host "  enabled:         $($d.enabled)"
    if ($d.connection_mode -ne "p2p" -and $d.connection_mode -ne "auto") {
        Write-Host "  -> Use Auto or Cloud mode in Settings for Easy4IP" -ForegroundColor Yellow
    }
} else {
    Write-Host "cameras.json not found at $CamerasJson" -ForegroundColor Red
}

if (-not $Py) {
    Write-Host "Python not found - cannot run P2P test." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Running cloud tunnel test (may take up to 3 min)..." -ForegroundColor Cyan
Set-Location $Backend
$env:PYTHONPATH = "."
& $Py (Join-Path $Backend "scripts\test_p2p_quick.py")
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Done. Restart the CarTrack backend, then Settings -> Camera cloud -> Connect." -ForegroundColor Green

# Expose local CarTrack API (http://localhost:8001) as HTTPS for Vercel.
# Requires: backend running (deploy.cmd). Downloads cloudflared if missing.

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$OutFile = Join-Path $PSScriptRoot ".tunnel-url.txt"
$Port = 8001

function Get-Cloudflared {
    $local = Join-Path $PSScriptRoot "cloudflared.exe"
    if (Test-Path $local) { return $local }
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    Write-Host "Downloading cloudflared..." -ForegroundColor Cyan
    $zip = Join-Path $env:TEMP "cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $zip -UseBasicParsing
    Copy-Item $zip $local -Force
    return $local
}

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -ne 200) { throw "not ok" }
} catch {
    Write-Host "Backend not responding on http://127.0.0.1:$Port" -ForegroundColor Red
    Write-Host "Start it first: run deploy.cmd from the project root." -ForegroundColor Yellow
    exit 1
}

$cf = Get-Cloudflared
Write-Host "Starting Cloudflare quick tunnel to port $Port ..." -ForegroundColor Cyan
Write-Host "Copy the https://....trycloudflare.com URL when it appears." -ForegroundColor Yellow
Write-Host ""

$log = Join-Path $env:TEMP "cartrack-cloudflared.log"
Remove-Item $log -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $cf -ArgumentList "tunnel", "--url", "http://127.0.0.1:$Port" -RedirectStandardOutput $log -RedirectStandardError $log -PassThru -NoNewWindow

$deadline = (Get-Date).AddSeconds(50)
$url = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
        $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
        if ($text -match "(https://[a-z0-9-]+\.trycloudflare\.com)") {
            $url = $Matches[1]
            break
        }
    }
}

if ($url) {
    $url | Set-Content -Path $OutFile -Encoding ASCII -NoNewline
    Write-Host ""
    Write-Host "Tunnel URL: $url" -ForegroundColor Green
    Write-Host "Saved to $OutFile — use as VITE_API_URL on Vercel." -ForegroundColor Green
    Write-Host "Leave cloudflared running (PID $($proc.Id)). Press Ctrl+C in that process to stop."
} else {
    Write-Host "Could not read tunnel URL from log. Open $log or run cloudflared manually." -ForegroundColor Yellow
    if (Test-Path $log) { Get-Content $log -Tail 20 }
}

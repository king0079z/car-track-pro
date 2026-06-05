# Stops stale CarTrack backend on port 8001 (including orphaned uvicorn --reload workers)
# then starts a fresh server. Run from project root:  .\restart-backend.ps1

$ErrorActionPreference = 'SilentlyContinue'
$BackendPort = 8001
$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Python = Join-Path $Backend 'venv\Scripts\python.exe'

Write-Host "Stopping processes on port $BackendPort..."

# Orphan uvicorn reload workers keep serving old code after the parent exits
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'spawn_main\(parent_pid=' } |
    ForEach-Object {
        Write-Host "  orphan worker PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force
    }

1..5 | ForEach-Object {
    Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -match 'uvicorn.*app\.main.*$BackendPort' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 1
}

Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "ERROR: port $BackendPort still in use. Close all CarTrack-Backend terminal windows and run this script again."
    exit 1
}

if (-not (Test-Path $Python)) {
    Write-Host "ERROR: venv not found at $Python — run deploy.cmd first."
    exit 1
}

Write-Host "Starting backend on http://localhost:$BackendPort ..."
Start-Process -FilePath $Python `
    -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', "$BackendPort" `
    -WorkingDirectory $Backend `
    -WindowStyle Normal

$ready = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    $code = (curl.exe -s -o NUL -w '%{http_code}' "http://127.0.0.1:$BackendPort/api/cameras/dahua/hero-a1")
    if ($code -eq '200') {
        $ready = $true
        break
    }
}

if ($ready) {
    Write-Host "Backend ready — Dahua camera API OK. Refresh the browser (Ctrl+Shift+R)."
} else {
    Write-Host "Backend started but camera API not responding yet. Wait a few seconds and refresh."
}

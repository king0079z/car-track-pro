<#
.SYNOPSIS
  Deploy CarTrack to the Hetzner VPS with ALL local data (SQLite DBs, config, models).

.DESCRIPTION
  1. Creates consistent SQLite snapshots (WAL-safe) from your local backend/
  2. Archives the project and uploads to the VPS (no git push required)
  3. Stops containers, restores databases + cameras.json, rebuilds Docker stack
  4. Optionally merges WHATSAPP_* / STREAM_* keys from backend/.env into .env.cloud

.EXAMPLE
  cd scripts
  .\deploy-with-data.ps1

.EXAMPLE
  .\deploy-with-data.ps1 -SkipCodeSync   # data-only refresh
#>
[CmdletBinding()]
param(
  [string] $VpsIp = "46.225.26.2",
  [string] $Domain = "cartrackpro.duckdns.org",
  [string] $SshUser = "root",
  [string] $SshKeyPath = (Join-Path $env:USERPROFILE ".ssh\cartrack_vps"),
  [string] $InstallDir = "/opt/cartrack",
  [switch] $SkipCodeSync,
  [switch] $SkipEnvMerge
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

function Import-DeployLocalEnv {
  $f = Join-Path $PSScriptRoot ".env.deploy.local"
  if (-not (Test-Path $f)) { return }
  Get-Content $f | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -lt 1) { return }
    $k = $line.Substring(0, $i).Trim()
    $v = $line.Substring($i + 1).Trim()
    if ($k -and $v) { Set-Item -Path "env:$k" -Value $v }
  }
}
Import-DeployLocalEnv

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Backend = Join-Path $Root "backend"
$CloudData = "deploy/cloud/data"
$Target = "${SshUser}@${VpsIp}"
$SshBase = @("-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20", "-o", "BatchMode=yes")
if (Test-Path $SshKeyPath) { $SshBase += @("-i", $SshKeyPath) }

foreach ($cmd in @("ssh", "scp")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd not found. Install OpenSSH Client (Windows Optional Features)."
  }
}

Step "Testing SSH to $Target ..."
& ssh @SshBase $Target "echo SSH_OK"
if ($LASTEXITCODE -ne 0) { throw "Cannot SSH to $Target" }

# ── 1. Consistent SQLite snapshots ─────────────────────────────────────────
Step "Creating local SQLite snapshots (WAL-safe) ..."
$Stage = Join-Path $env:TEMP "cartrack-deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$DataStage = Join-Path $Stage "data"
New-Item -ItemType Directory -Force -Path $DataStage | Out-Null

$pyScript = @'
import os, sqlite3, shutil, sys
backend = sys.argv[1]
out = sys.argv[2]
os.makedirs(out, exist_ok=True)

def backup_sqlite(name):
    src = os.path.join(backend, name)
    if not os.path.isfile(src):
        return False
    dst = os.path.join(out, name)
    with sqlite3.connect(src, timeout=60.0) as conn, sqlite3.connect(dst) as outdb:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.backup(outdb)
    return True

for db in ("cartrack.db", "analysis_history.db", "live_sessions.db", "plates_local.db"):
    if backup_sqlite(db):
        print("  backed up", db)

for j in ("cameras.json", "settings.json"):
    src = os.path.join(backend, j)
    if os.path.isfile(src):
        shutil.copy2(src, os.path.join(out, j))
        print("  copied", j)
'@

$pyFile = Join-Path $Stage "snapshot.py"
Set-Content -Path $pyFile -Value $pyScript -Encoding UTF8
python $pyFile $Backend $DataStage
if ($LASTEXITCODE -ne 0) { throw "SQLite snapshot failed" }

$dbSize = (Get-ChildItem $DataStage -File | Measure-Object -Property Length -Sum).Sum / 1MB
Ok ("Data snapshot: {0:N2} MB in {1}" -f $dbSize, $DataStage)

# ── 2. Upload code archive (optional) ───────────────────────────────────────
if (-not $SkipCodeSync) {
  Step "Packaging project for upload (excludes node_modules, _dmss_re, .git) ..."
  $Archive = Join-Path $Stage "cartrack-src.tar.gz"
  $tarExclude = @(
    "--exclude=node_modules",
    "--exclude=frontend/node_modules",
    "--exclude=frontend/dist",
    "--exclude=_dmss_re",
    "--exclude=.git",
    "--exclude=backend/__pycache__",
    "--exclude=backend/.pytest_cache",
    "--exclude=backend/backups",
    "--exclude=backend/cartrack.db",
    "--exclude=backend/cartrack.db-wal",
    "--exclude=backend/cartrack.db-shm",
    "--exclude=backend/analysis_history.db",
    "--exclude=backend/live_sessions.db",
    "--exclude=backend/plates_local.db",
    "--exclude=*.pt"
  )
  Push-Location $Root
  try {
    if (Get-Command tar -ErrorAction SilentlyContinue) {
      & tar -czf $Archive @tarExclude .
    } else {
      throw "tar not found. Install tar (Windows 10+) or run with -SkipCodeSync after pushing to GitHub."
    }
  } finally { Pop-Location }
  $archMb = (Get-Item $Archive).Length / 1MB
  Ok ("Archive: {0:N1} MB" -f $archMb)

  Step "Uploading source archive (~may take a few minutes) ..."
  & scp @SshBase $Archive "${Target}:/root/cartrack-src.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "Source upload failed" }

  Step "Extracting on VPS -> $InstallDir ..."
  $remoteExtract = "mkdir -p '$InstallDir' && tar -xzf /root/cartrack-src.tar.gz -C '$InstallDir' && find '$InstallDir/deploy/cloud' -name '*.sh' -exec sed -i 's/\r$//' {} + 2>/dev/null; rm -f /root/cartrack-src.tar.gz"
  & ssh @SshBase $Target $remoteExtract
  if ($LASTEXITCODE -ne 0) { throw "Extract failed on VPS" }
  Ok "Source synced."
} else {
  Step "Skipping code sync (-SkipCodeSync)"
}

# ── 3. Model weights ─────────────────────────────────────────────────────────
$Weights = Join-Path $Backend "models\best.pt"
if (Test-Path $Weights) {
  Step "Uploading YOLO weights best.pt ..."
  & scp @SshBase $Weights "${Target}:/root/best.pt"
  & ssh @SshBase $Target "mkdir -p '$InstallDir/deploy/cloud/data/models' && cp -f /root/best.pt '$InstallDir/deploy/cloud/data/models/best.pt'"
  Ok "Weights installed."
}

# ── 4. Upload data + stop backend ────────────────────────────────────────────
Step "Uploading databases and config ..."
& ssh @SshBase $Target "mkdir -p /root/cartrack-data"
& scp @SshBase "$DataStage/*" "${Target}:/root/cartrack-data/"
if ($LASTEXITCODE -ne 0) { throw "Data upload failed" }

Step "Stopping backend (safe DB restore) ..."
$CloudDir = "$InstallDir/deploy/cloud"
$restoreCmd = "cd '$CloudDir' && docker compose -f docker-compose.oracle.yml stop backend 2>/dev/null; mkdir -p data; for f in cartrack.db analysis_history.db live_sessions.db plates_local.db cameras.json settings.json; do if [ -f /root/cartrack-data/`$f ]; then cp -f /root/cartrack-data/`$f data/`$f && echo restored `$f; fi; done; rm -f data/cartrack.db-wal data/cartrack.db-shm 2>/dev/null; chmod -R a+rw data 2>/dev/null"
& ssh @SshBase $Target $restoreCmd
Ok "Data restored to deploy/cloud/data/"

# ── 5. Merge env keys from local backend/.env ────────────────────────────────
if (-not $SkipEnvMerge) {
  $localEnv = Join-Path $Backend ".env"
  if (Test-Path $localEnv) {
    Step "Merging selected keys from backend/.env → .env.cloud ..."
    $keys = @(
      "WHATSAPP_ENABLED", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_DEFAULT_COUNTRY_CODE", "WHATSAPP_DRY_RUN",
      "WHATSAPP_FULL_REPORT", "STREAM_SAVER_ENABLED", "LIVE_IDLE_ENABLED"
    )
    $mergeLines = @()
    foreach ($line in Get-Content $localEnv) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith("#")) { continue }
      $k = ($t -split "=", 2)[0].Trim()
      if ($keys -contains $k) { $mergeLines += $t }
    }
    if ($mergeLines.Count -gt 0) {
      $mergeFile = Join-Path $Stage "env-merge.txt"
      Set-Content -Path $mergeFile -Value ($mergeLines -join "`n") -Encoding UTF8
      & scp @SshBase $mergeFile "${Target}:/root/env-merge.txt"
      $mergeRemote = "ENV='$CloudDir/.env.cloud'; touch `"`$ENV`"; while IFS= read -r line; do [ -z `"`$line`" ] && continue; key=`"`${line%%=*}`"; grep -v `"^`${key}=`" `"`$ENV`" > `"`$ENV.tmp`" || true; mv `"`$ENV.tmp`" `"`$ENV`"; echo `"`$line`" >> `"`$ENV`"; done < /root/env-merge.txt; rm -f /root/env-merge.txt; echo env_merged"
      & ssh @SshBase $Target $mergeRemote
      Ok "Env merge done (WhatsApp / stream settings)."
    }
  }
}

# ── 6. Rebuild & start ───────────────────────────────────────────────────────
Step "Building and starting Docker stack (zero-downtime) ..."
$buildCmd = "cd '$CloudDir' && export CADDY_DOMAIN='$Domain' && bash zero-downtime-deploy.sh all"
& ssh @SshBase $Target $buildCmd
if ($LASTEXITCODE -ne 0) { throw "Docker build failed. Check: ssh $Target 'cd $CloudDir && docker compose -f docker-compose.oracle.yml logs --tail=80 backend'" }

Step "Waiting for health check ..."
Start-Sleep -Seconds 35
$healthCmd = "curl -sf https://$Domain/api/health 2>/dev/null || curl -sf http://127.0.0.1/api/health 2>/dev/null || echo FAIL"
$health = & ssh @SshBase $Target $healthCmd
if ($health -match "FAIL") { Write-Host "    Health check did not return OK yet - stack may still be starting." -ForegroundColor Yellow }
else { Ok "Health: $health" }

Write-Host ""
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host " Deploy complete (app + local data)" -ForegroundColor Green
Write-Host "  URL:    https://$Domain" -ForegroundColor Green
Write-Host "  Health: https://$Domain/api/health" -ForegroundColor Green
Write-Host "  Data:   SQLite DBs restored from local backend/" -ForegroundColor Green
Write-Host "══════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue

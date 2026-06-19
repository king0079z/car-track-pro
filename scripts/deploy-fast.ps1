<#
.SYNOPSIS
  Fast, data-safe deploy to VPS — minimal downtime, never touches SQLite data.

.PARAMETER DeployTarget
  PatchBackend = Python-only hotfix (~30s, no Docker rebuild) — DEFAULT for backend/app changes.
  Frontend     = UI only (~2-4 min).
  Backend      = full image rebuild (~3-8 min when pip layer cached).
  All          = both images — SLOW (~15 min); only when Dockerfile/requirements changed on both tiers.

.EXAMPLE
  cd scripts
  .\deploy-fast.ps1 -DeployTarget PatchBackend
#>
[CmdletBinding()]
param(
  [ValidateSet('PatchBackend', 'Frontend', 'Backend', 'All')]
  [Alias('Target')]
  [string] $DeployTarget = 'PatchBackend',
  [string] $VpsIp = '46.225.26.2',
  [string] $Domain = 'cartrackpro.duckdns.org',
  [string] $SshUser = 'root',
  [string] $SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\cartrack_vps'),
  [string] $InstallDir = '/opt/cartrack'
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SshHost = "${SshUser}@${VpsIp}"
$SshBase = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes')
if (Test-Path $SshKeyPath) { $SshBase += @('-i', $SshKeyPath) }

Step 'Testing SSH ...'
& ssh @SshBase $SshHost 'echo SSH_OK'
if ($LASTEXITCODE -ne 0) { throw "Cannot SSH to $SshHost" }

$Stage = Join-Path $env:TEMP "cartrack-patch-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$PatchTar = Join-Path $Stage 'patch.tar.gz'

Step "Packaging patch ($DeployTarget) ..."
Push-Location $Root
try {
  $includes = @('deploy/cloud/zero-downtime-deploy.sh', 'deploy/cloud/docker-compose.oracle.yml')
  if ($DeployTarget -in @('Frontend', 'All')) {
    $includes += @(
      'frontend/src', 'frontend/package.json', 'frontend/package-lock.json',
      'frontend/vite.config.ts', 'frontend/tsconfig.json', 'frontend/tsconfig.app.json',
      'frontend/index.html', 'deploy/cloud/frontend.Dockerfile', 'deploy/cloud/Caddyfile.oracle'
    )
  }
  if ($DeployTarget -in @('PatchBackend', 'Backend', 'All')) {
    $includes += @('backend/app')
    if ($DeployTarget -in @('Backend', 'All')) {
      $includes += @('backend/requirements.txt', 'backend/Dockerfile', 'backend/pyproject.toml')
    }
  }
  $tarArgs = @('-czf', $PatchTar)
  foreach ($inc in $includes) {
    if (Test-Path $inc) { $tarArgs += $inc }
  }
  & tar @tarArgs
  Ok ("Patch: {0:N1} MB" -f ((Get-Item $PatchTar).Length / 1MB))
} finally { Pop-Location }

Step 'Uploading patch ...'
& scp @SshBase $PatchTar "${SshHost}:/root/cartrack-patch.tar.gz"

$remoteRoll = switch ($DeployTarget) {
  'PatchBackend' { 'patch-backend' }
  'Frontend'     { 'frontend' }
  'Backend'      { 'backend' }
  'All'          { 'all' }
}

$remote = "set -e; cd '$InstallDir'; tar -xzf /root/cartrack-patch.tar.gz; chmod +x deploy/cloud/zero-downtime-deploy.sh 2>/dev/null || true; find deploy/cloud -name '*.sh' -exec sed -i 's/\r$//' {} + 2>/dev/null || true; rm -f /root/cartrack-patch.tar.gz; export CADDY_DOMAIN='$Domain'; bash deploy/cloud/zero-downtime-deploy.sh '$remoteRoll'"

Step "Roll-out ($DeployTarget -> $remoteRoll) ..."
& ssh @SshBase $SshHost $remote
if ($LASTEXITCODE -ne 0) { throw 'Deploy failed on VPS' }

Step 'Health check ...'
Start-Sleep -Seconds 5
$health = & ssh @SshBase $SshHost "curl -sf https://$Domain/api/health 2>/dev/null || echo FAIL"
if ($health -match 'FAIL') { Write-Host '    Health pending — stack may still be starting.' -ForegroundColor Yellow }
else { Ok "API healthy: $($health.Substring(0, [Math]::Min(60, $health.Length)))..." }

Write-Host ''
Write-Host "Deploy complete ($DeployTarget, data untouched)." -ForegroundColor Green
Write-Host "  https://$Domain" -ForegroundColor Green
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue

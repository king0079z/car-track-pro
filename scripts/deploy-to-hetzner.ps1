<#
.SYNOPSIS
  Deploy CarTrack to your Hetzner VPS (one command from Windows).

.DESCRIPTION
  Uploads YOLO weights + config, then bootstraps the VPS:
  Docker, HTTPS (cartrackpro.duckdns.org), Dahua P2P 24/7 ANPR.

.EXAMPLE
  cd "C:\Users\Mohamed\Desktop\Car Tracking system1\scripts"
  .\deploy-to-hetzner.ps1 -DuckDnsToken "your-token-here"

.EXAMPLE
  .\deploy-to-hetzner.ps1 -VpsIp "46.225.26.2" -DuckDnsToken "..." -CameraPassword "your-cam-admin-pass"
#>
[CmdletBinding()]
param(
  [string] $VpsIp = "46.225.26.2",
  [string] $Domain = "cartrackpro.duckdns.org",
  [Parameter(Mandatory = $true)]
  [string] $DuckDnsToken,
  [string] $CameraPassword = "",
  [string] $SshUser = "root",
  [string] $RepoUrl = "https://github.com/king0079z/car-track-pro.git"
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Weights = Join-Path $Root "backend\models\best.pt"
$Bootstrap = Join-Path $Root "deploy\cloud\bootstrap-vps.sh"
$EnvTemplate = Join-Path $Root "deploy\cloud\env.cartrackpro.template"

foreach ($p in @($Weights, $Bootstrap, $EnvTemplate)) {
  if (-not (Test-Path $p)) { throw "Missing required file: $p" }
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "OpenSSH client not found. Install: Settings → Apps → Optional features → OpenSSH Client"
}
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw "scp not found. Install OpenSSH Client (same as above)."
}

if (-not $CameraPassword) {
  $sec = Read-Host "Dahua camera admin password (from DMSS, not email login)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $CameraPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if (-not $CameraPassword) { throw "Camera password cannot be empty." }

$Target = "${SshUser}@${VpsIp}"
Step "Testing SSH to $Target ..."
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $Target "echo SSH OK"
if ($LASTEXITCODE -ne 0) { throw "Cannot SSH to $Target. Check IP, firewall (port 22), and credentials." }

Step "Uploading best.pt (~6 MB) ..."
scp -o StrictHostKeyChecking=accept-new $Weights "${Target}:/root/best.pt"

Step "Uploading bootstrap script + env template ..."
scp -o StrictHostKeyChecking=accept-new $Bootstrap "${Target}:/root/bootstrap-vps.sh"
scp -o StrictHostKeyChecking=accept-new $EnvTemplate "${Target}:/root/env.cartrackpro.template"

Step "Running bootstrap on VPS (Docker build ~10-15 min) ..."
$escapedPwd = $CameraPassword -replace "'", "'\\''"
$remoteCmd = @"
chmod +x /root/bootstrap-vps.sh
export CARTRACK_REPO_URL='$RepoUrl'
sudo bash /root/bootstrap-vps.sh '$Domain' '$DuckDnsToken' '$escapedPwd'
"@
ssh -o StrictHostKeyChecking=accept-new $Target $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "Bootstrap failed on VPS. SSH in and check: docker compose -f /opt/cartrack/deploy/cloud/docker-compose.oracle.yml logs backend" }

Write-Host ""
Write-Host "Deployment complete." -ForegroundColor Green
Write-Host "  Dashboard:  https://$Domain"
Write-Host "  Health:     https://$Domain/api/health"
Write-Host "  Login:      admin / demo1234"
Write-Host ""
Write-Host "Watch P2P tunnel: ssh $Target 'cd /opt/cartrack/deploy/cloud && docker compose -f docker-compose.oracle.yml logs -f backend'"

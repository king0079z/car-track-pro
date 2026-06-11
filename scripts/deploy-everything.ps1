<#
.SYNOPSIS
  Deploy CarTrack to ALL platforms from one script.

.DESCRIPTION
  1. Git push (so VPS / Render / HF get latest code)
  2. Hetzner VPS — 24/7 live ANPR + HTTPS (cartrackpro.duckdns.org)
  3. Hugging Face Space — optional upload-demo Space
  4. Prints Vercel env (frontend → your VPS API)

.EXAMPLE
  cd scripts
  .\deploy-everything.ps1

  Or non-interactive (secrets in env):
  $env:CARTRACK_DUCKDNS_TOKEN = "..."
  $env:CARTRACK_CAMERA_PASSWORD = "..."
  $env:CARTRACK_HF_TOKEN = "..."   # optional
  .\deploy-everything.ps1 -SkipGitPush
#>
[CmdletBinding()]
param(
  [string] $VpsIp = "46.225.26.2",
  [string] $Domain = "cartrackpro.duckdns.org",
  [string] $DuckDnsToken = $env:CARTRACK_DUCKDNS_TOKEN,
  [string] $CameraPassword = $env:CARTRACK_CAMERA_PASSWORD,
  [string] $HfToken = $env:CARTRACK_HF_TOKEN,
  [string] $HfSpaceId = $env:CARTRACK_HF_SPACE,
  [string] $RepoUrl = "https://github.com/king0079z/car-track-pro.git",
  [switch] $SkipGitPush,
  [switch] $SkipHetzner,
  [switch] $SkipHuggingFace,
  [switch] $SkipVercelHint
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

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
if (-not $DuckDnsToken) { $DuckDnsToken = $env:CARTRACK_DUCKDNS_TOKEN }
if (-not $CameraPassword) { $CameraPassword = $env:CARTRACK_CAMERA_PASSWORD }
if (-not $HfToken) { $HfToken = $env:CARTRACK_HF_TOKEN }
if (-not $HfSpaceId) { $HfSpaceId = $env:CARTRACK_HF_SPACE }

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "    $m" -ForegroundColor Yellow }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  CarTrack - Deploy EVERYTHING" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# ── Collect secrets ─────────────────────────────────────────────────────────
if (-not $DuckDnsToken) {
  $DuckDnsToken = Read-Host "DuckDNS token (from duckdns.org top of page)"
}
if (-not $CameraPassword -and -not $SkipHetzner) {
  $sec = Read-Host "Dahua camera admin password (DMSS device password)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $CameraPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# ── [1] Git push ────────────────────────────────────────────────────────────
if (-not $SkipGitPush) {
  Step '[1/4] Pushing latest code to GitHub'
  Push-Location $Root
  try {
    $dirty = git status --porcelain 2>&1
    if ($dirty) {
      git add deploy/ scripts/deploy-to-hetzner.ps1 scripts/deploy-everything.ps1 `
        backend/app/config.py backend/app/services/camera_config.py backend/app/utils/plates.py `
        backend/pyproject.toml backend/tests/test_dahua_camera.py backend/tests/test_live_24_7.py `
        backend/tests/test_live_plate_filter.py deploy/huggingface/ 2>$null
      git add -u backend/pytest.ini 2>$null
      git commit -m "Update deployment scripts and cloud config" 2>$null
      if ($LASTEXITCODE -ne 0) { Warn "Nothing new to commit (or commit skipped)." }
    }
    git push origin HEAD 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) { Ok "GitHub updated - VPS bootstrap can clone latest." }
    else { Warn "git push failed - push manually, then re-run with -SkipGitPush" }
  } finally {
    Pop-Location
  }
} else {
  Step '[1/4] Skipping git push (-SkipGitPush)'
}

# ── [2] Hetzner VPS ─────────────────────────────────────────────────────────
if (-not $SkipHetzner) {
  Step ('[2/4] Hetzner VPS - live ANPR at https://' + $Domain)
  & (Join-Path $PSScriptRoot "deploy-to-hetzner.ps1") `
    -VpsIp $VpsIp `
    -Domain $Domain `
    -DuckDnsToken $DuckDnsToken `
    -CameraPassword $CameraPassword `
    -RepoUrl $RepoUrl
  Ok "Hetzner deploy finished."
} else {
  Step '[2/4] Skipping Hetzner (-SkipHetzner)'
}

# ── [3] Hugging Face (optional) ─────────────────────────────────────────────
if (-not $SkipHuggingFace) {
  Step '[3/4] Hugging Face Space (upload-video demo)'
  if (-not $HfToken) {
    $doHf = Read-Host "Push HF Space too? Needs hf_ write token (y/N)"
    if ($doHf -eq "y") {
      $HfToken = Read-Host "HF write token"
    } else {
      $SkipHuggingFace = $true
    }
  }
  if (-not $SkipHuggingFace -and $HfToken) {
    if (-not $HfSpaceId) {
      $HfSpaceId = Read-Host "HF Space id (e.g. yourname/cartrack)"
    }
    & (Join-Path $Root "deploy\huggingface\push-to-space.ps1") `
      -SpaceId $HfSpaceId -HfToken $HfToken
    Ok "HF push done - build at https://huggingface.co/spaces/$HfSpaceId"
  }
} else {
  Step '[3/4] Skipping Hugging Face (-SkipHuggingFace)'
}

# ── [4] Vercel hint ─────────────────────────────────────────────────────────
if (-not $SkipVercelHint) {
  Step '[4/4] Vercel frontend (optional split UI)'
  $apiUrl = "https://$Domain"
  Write-Host ""
  Write-Host "  If you also use Vercel for the UI, set:" -ForegroundColor White
  Write-Host "    VITE_API_URL = $apiUrl" -ForegroundColor White
  Write-Host "  Then redeploy frontend." -ForegroundColor White
  Write-Host ""
  Write-Host "  Or skip Vercel - the VPS already serves the full app at:" -ForegroundColor White
  Write-Host "    https://$Domain" -ForegroundColor White
  Write-Host ""
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " ALL DEPLOYMENTS COMPLETE" -ForegroundColor Green
Write-Host "  Primary (24-7 live):  https://$Domain" -ForegroundColor Green
Write-Host "  Login:               admin / demo1234" -ForegroundColor Green
Write-Host "  Health:              https://$Domain/api/health" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

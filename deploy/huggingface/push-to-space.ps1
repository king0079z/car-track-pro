<#
.SYNOPSIS
  Package and push CarTrack to a Hugging Face Docker Space (single-port demo).

.DESCRIPTION
  Builds a clean Space repo from this project (frontend + backend + trained
  weights + the HF Dockerfile/README) and pushes it to your Space. Hugging Face
  then builds the image and serves the dashboard at https://<id>.hf.space.

  Excludes heavy/ephemeral local data (venv, outputs, uploads, *.mp4, *.db).

.PREREQUISITES
  - Git and Git LFS installed:   winget install Git.Git ; git lfs install
  - A Hugging Face account + a *Docker* Space already created (see the guide).
  - A HF access token with WRITE scope: https://huggingface.co/settings/tokens

.EXAMPLE
  ./push-to-space.ps1 -SpaceId "yourname/cartrack" -HfToken "hf_xxx"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $SpaceId,   # e.g. "yourname/cartrack"
  [Parameter(Mandatory = $true)] [string] $HfToken,   # hf_... (write scope)
  [string] $HfUser = ""                                # defaults to the part before "/"
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# Resolve repo paths relative to this script (deploy/huggingface/).
$HereDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $HereDir "..\..")).Path
if (-not $HfUser) { $HfUser = $SpaceId.Split("/")[0] }

foreach ($cmd in @("git")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd is not installed. Install Git (winget install Git.Git) and re-run."
  }
}
git lfs version *> $null
if ($LASTEXITCODE -ne 0) { throw "Git LFS not found. Run: git lfs install" }

# Sanity-check the weights are present (ANPR won't load without them).
$ModelsDir = Join-Path $RepoRoot "backend\models"
$weights = Get-ChildItem -Path $ModelsDir -Filter *.pt -ErrorAction SilentlyContinue
if (-not $weights) {
  throw "No YOLO weights (*.pt) in backend/models/. ANPR can't run without them."
}
Step ("Found {0} weight file(s) in backend/models" -f $weights.Count)

# Staging clone of the Space.
$Stage = Join-Path $env:TEMP ("cartrack-space-" + [guid]::NewGuid().ToString("N").Substring(0,8))
$RemoteUrl = "https://huggingface.co/spaces/$SpaceId"
$AuthUrl   = "https://${HfUser}:${HfToken}@huggingface.co/spaces/$SpaceId"

Step "Cloning Space $RemoteUrl"
git clone $AuthUrl $Stage 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Could not clone $RemoteUrl. Create the Space first (SDK=Docker) and check the token."
}

# Wipe tracked content (keep .git) so removed files are reflected, then refill.
Step "Staging project files (excluding venv/outputs/uploads/db/videos)"
Get-ChildItem -Path $Stage -Force |
  Where-Object { $_.Name -ne ".git" } |
  Remove-Item -Recurse -Force

$RoboExclDirs = @("venv", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache",
                  "node_modules", "dist", "outputs", "uploads", "runs", "ocr_dataset")
$RoboExclFiles = @("*.mp4", "*.avi", "*.mov", "*.mkv", "*.db", "*.db-shm", "*.db-wal", "*.log", "*.pyc")

function Copy-Tree($srcRel) {
  $src = Join-Path $RepoRoot $srcRel
  $dst = Join-Path $Stage $srcRel
  robocopy $src $dst /E /XD $RoboExclDirs /XF $RoboExclFiles /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying $srcRel (code $LASTEXITCODE)" }
}

Copy-Tree "frontend"
Copy-Tree "backend"

# HF entrypoint files go at the Space ROOT.
Copy-Item (Join-Path $HereDir "Dockerfile")     (Join-Path $Stage "Dockerfile")     -Force
Copy-Item (Join-Path $HereDir "README.md")       (Join-Path $Stage "README.md")       -Force
Copy-Item (Join-Path $HereDir ".dockerignore")   (Join-Path $Stage ".dockerignore")   -Force
Copy-Item (Join-Path $HereDir ".gitattributes")  (Join-Path $Stage ".gitattributes")  -Force

Push-Location $Stage
try {
  git lfs install --local *> $null
  # Make sure weights are tracked by LFS even if .gitattributes was added late.
  git lfs track "*.pt" *> $null

  git add -A
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
  git -c user.email="deploy@cartrack.local" -c user.name="CarTrack Deploy" `
      commit -m "Deploy CarTrack to HF Space ($stamp)" 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "    (nothing changed since last push)" -ForegroundColor Yellow }

  Step "Pushing to Hugging Face (build starts automatically)"
  git push $AuthUrl HEAD:main
  if ($LASTEXITCODE -ne 0) { throw "git push failed — check the token has WRITE scope." }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done. Watch the build + open the app at:" -ForegroundColor Green
Write-Host "    https://huggingface.co/spaces/$SpaceId        (build logs)"
Write-Host "    https://$($SpaceId.Replace('/','-')).hf.space  (the dashboard)"
Write-Host "Login: admin / demo1234"
Write-Host ""
Write-Host "Cleanup staging dir:  Remove-Item -Recurse -Force '$Stage'"

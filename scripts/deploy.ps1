<#
.SYNOPSIS
  Standard CarTrack VPS deploy — auto-picks the fastest safe method.

.DESCRIPTION
  backend/app only     -> PatchBackend (~30s, no Docker rebuild)
  frontend only        -> Frontend (~2-4 min)
  backend + frontend   -> PatchBackend then Frontend (NOT a slow "All" rebuild)
  requirements/Dockerfile -> Backend full rebuild
  Never uses -DeployTarget All unless you pass it explicitly.

.EXAMPLE
  cd scripts
  .\deploy.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('Auto', 'PatchBackend', 'Frontend', 'Backend', 'All')]
  [string] $DeployTarget = 'Auto',
  [string] $VpsIp = '46.225.26.2',
  [string] $Domain = 'cartrackpro.duckdns.org'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Fast = Join-Path $PSScriptRoot 'deploy-fast.ps1'

function Get-ChangedPaths {
  Push-Location $Root
  try {
    $paths = @(git diff --name-only HEAD 2>$null) + @(git diff --name-only --cached 2>$null) + @(git ls-files --others --exclude-standard 2>$null)
    return @($paths | Where-Object { $_ } | Select-Object -Unique)
  } finally { Pop-Location }
}

function Resolve-DeployPlan {
  param([string[]] $Changed)
  if (-not $Changed.Count) {
    Write-Host 'No git changes — using PatchBackend (safest no-op check).' -ForegroundColor Yellow
    return @('PatchBackend')
  }

  $fe = @($Changed | Where-Object { $_ -match '^frontend/' })
  $beApp = @($Changed | Where-Object { $_ -match '^backend/app/' })
  $beInfra = @($Changed | Where-Object { $_ -match '^backend/(requirements\.txt|Dockerfile|pyproject\.toml)$' })
  $deployInfra = @($Changed | Where-Object { $_ -match '^deploy/cloud/' -and $_ -notmatch 'zero-downtime-deploy\.sh$' })

  if ($beInfra.Count -gt 0 -or $deployInfra.Count -gt 0) {
    if ($fe.Count -gt 0) {
      Write-Host 'Infra + frontend changed — Backend rebuild then Frontend.' -ForegroundColor Cyan
      return @('Backend', 'Frontend')
    }
    return @('Backend')
  }

  $plan = [System.Collections.Generic.List[string]]::new()
  if ($beApp.Count -gt 0 -or ($Changed | Where-Object { $_ -match '^backend/' }).Count -gt 0) {
    $plan.Add('PatchBackend')
  }
  if ($fe.Count -gt 0) {
    $plan.Add('Frontend')
  }
  if ($plan.Count -eq 0) {
    if ($Changed | Where-Object { $_ -match '^deploy/cloud/zero-downtime-deploy\.sh$' }) {
      return @('PatchBackend')
    }
    $plan.Add('Frontend')
  }
  return @($plan)
}

if ($DeployTarget -eq 'Auto') {
  $plan = Resolve-DeployPlan (Get-ChangedPaths)
  Write-Host ("Auto plan: {0}" -f ($plan -join ' -> ')) -ForegroundColor Cyan
} else {
  $plan = @($DeployTarget)
}

foreach ($step in $plan) {
  Write-Host ''
  Write-Host "=== Step: $step ===" -ForegroundColor Cyan
  & $Fast -DeployTarget $step -VpsIp $VpsIp -Domain $Domain
  if ($LASTEXITCODE -ne 0) { throw "Deploy step '$step' failed" }
}

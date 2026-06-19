<#
.SYNOPSIS
  Legacy alias — use deploy.ps1 (auto) instead.
#>
[CmdletBinding()]
param(
  [ValidateSet('Auto', 'PatchBackend', 'Frontend', 'Backend', 'All')]
  [string] $DeployTarget = 'Auto'
)
& (Join-Path $PSScriptRoot 'deploy.ps1') -DeployTarget $DeployTarget

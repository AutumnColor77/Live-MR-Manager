#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot pre-build supply-chain gate: licenses + vulnerability audits.
#>
[CmdletBinding()]
param([switch]$Strict)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$lic = Join-Path $Root "scripts\check-licenses.ps1"
$aud = Join-Path $Root "scripts\audit-deps.ps1"

if ($Strict) {
    & $lic -Strict
    & $aud -Strict
} else {
    & $lic
    & $aud
}

Write-Host "`nPre-build supply-chain gate PASSED." -ForegroundColor Green
exit 0

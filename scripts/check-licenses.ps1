#Requires -Version 5.1
<#
.SYNOPSIS
  Full license inventory + AI/Alignment model compatibility gate.

.EXAMPLE
  ./scripts/check-licenses.ps1
  ./scripts/check-licenses.ps1 -Strict
#>
[CmdletBinding()]
param(
    [switch]$Strict,
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ReportDir = Join-Path $Root "reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

function Invoke-Py([string[]]$PyArgs) {
    & $Python @PyArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Python exited with code $LASTEXITCODE ($($PyArgs -join ' '))"
    }
}

Write-Host "==> License inventory (Cargo.lock + package-lock.json)" -ForegroundColor Cyan
$invArgs = @(
    (Join-Path $Root "scripts\supply-chain\inventory_licenses.py"),
    "--out", (Join-Path $ReportDir "license-inventory.json"),
    "--markdown", (Join-Path $ReportDir "license-inventory.md")
)
if ($Strict) { $invArgs += "--strict" }
Invoke-Py $invArgs

Write-Host "`n==> Model / MIT compatibility (MODEL_LICENSING + notices + Rust catalogs)" -ForegroundColor Cyan
$modelArgs = @(
    (Join-Path $Root "scripts\supply-chain\check_model_license_compat.py"),
    "--out", (Join-Path $ReportDir "model-license-compat.json")
)
if ($Strict) { $modelArgs += "--strict-provisional" }
Invoke-Py $modelArgs

Write-Host "`nLicense checks PASSED. Reports in $ReportDir" -ForegroundColor Green
exit 0

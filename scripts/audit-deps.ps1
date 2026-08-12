#Requires -Version 5.1
<#
.SYNOPSIS
  Pre-build dependency vulnerability scan (cargo-audit + npm audit).

.DESCRIPTION
  Fails the process when High/Critical issues are reported.
  Optional: -SkipInstall to avoid installing cargo-audit via cargo install.

.EXAMPLE
  ./scripts/audit-deps.ps1
  ./scripts/audit-deps.ps1 -Strict
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$Strict,
    [string]$ReportDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $ReportDir) {
    $ReportDir = Join-Path $Root "reports"
}
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Ensure-CargoAudit {
    if (Get-Command cargo-audit -ErrorAction SilentlyContinue) { return }
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        $list = & cargo install --list 2>$null
        if ($list -match "(?m)^cargo-audit\s") { return }
    }
    if ($SkipInstall) {
        throw "cargo-audit not found. Install with: cargo install cargo-audit --locked"
    }
    Write-Step "Installing cargo-audit (cargo install --locked)"
    & cargo install cargo-audit --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo install cargo-audit failed" }
}

$failures = @()

# --- Rust (Cargo.lock) ---
Write-Step "cargo audit (src-tauri/Cargo.lock)"
Ensure-CargoAudit
$cargoJson = Join-Path $ReportDir "cargo-audit.json"
Push-Location (Join-Path $Root "src-tauri")
try {
    & cargo audit --json 2>$null | Out-File -FilePath $cargoJson -Encoding utf8
    # Human-readable gate (exit code)
    & cargo audit
    if ($LASTEXITCODE -ne 0) {
        $failures += "cargo-audit reported vulnerabilities (see $cargoJson)"
    }
}
finally {
    Pop-Location
}

# --- npm (root + companion) ---
function Invoke-NpmAudit([string]$Prefix, [string]$Label) {
    $lock = Join-Path $Prefix "package-lock.json"
    if (-not (Test-Path $lock)) {
        Write-Host "skip $Label (no package-lock.json)" -ForegroundColor Yellow
        return
    }
    Write-Step "npm audit ($Label) — fail on high+"
    $out = Join-Path $ReportDir ("npm-audit-{0}.json" -f $Label)
    $level = if ($Strict) { "moderate" } else { "high" }
    Push-Location $Prefix
    try {
        # JSON report (do not fail the shell yet)
        & npm audit --json 2>$null | Out-File -FilePath $out -Encoding utf8
        & npm audit --audit-level=$level
        if ($LASTEXITCODE -ne 0) {
            $script:failures += "npm audit ($Label) failed at audit-level=$level (see $out)"
        }
    }
    finally {
        Pop-Location
    }
}

Invoke-NpmAudit -Prefix $Root -Label "app-root"
Invoke-NpmAudit -Prefix (Join-Path $Root "web\companion") -Label "companion"

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "Dependency audit FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "Dependency audit PASSED (cargo-audit + npm audit)." -ForegroundColor Green
exit 0

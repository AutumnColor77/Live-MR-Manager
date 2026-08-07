# Ensures Microsoft Visual C++ Redistributable (x64) is present for NSIS bundling.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root "src-tauri\resources"
$OutFile = Join-Path $OutDir "vc_redist.x64.exe"
$Url = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
$MinBytes = 1MB

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ((Test-Path $OutFile) -and ((Get-Item $OutFile).Length -ge $MinBytes)) {
    Write-Host "vc_redist.x64.exe already present ($([math]::Round((Get-Item $OutFile).Length / 1MB, 1)) MB)"
    exit 0
}

Write-Host "Downloading Visual C++ Redistributable from $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing

if (-not (Test-Path $OutFile) -or ((Get-Item $OutFile).Length -lt $MinBytes)) {
    throw "Failed to download vc_redist.x64.exe"
}

Write-Host "Saved $OutFile ($([math]::Round((Get-Item $OutFile).Length / 1MB, 1)) MB)"

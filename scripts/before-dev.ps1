# beforeDevCommand: ensure VC++ redist (for bundle.resources check), then start frontend.
$ErrorActionPreference = "Stop"
& "$PSScriptRoot\ensure-vcredist.ps1"
Set-Location (Split-Path -Parent $PSScriptRoot)
npm run dev

# ort-sys 2.0.0-rc.12 copy-dylibs assumes Cargo's old build OUT_DIR layout
# (`build/ort-sys-<hash>/out` → ancestors().nth(3) == target/<profile>).
# Newer Cargo uses `build/ort-sys/<hash>/out`, so nth(3) lands on `build/`
# and then copy into `build/examples` / `build/deps` fails with NotFound.
# Pre-create those dirs so the unwrap'd copy succeeds on CI.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$profiles = @("release", "debug")
foreach ($profile in $profiles) {
  $base = Join-Path $root "src-tauri/target/$profile"
  foreach ($rel in @(
      "examples",
      "deps",
      "build",
      "build/examples",
      "build/deps"
    )) {
    $path = Join-Path $base $rel
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}
Write-Host "[ensure-ort-copy-dirs] ready under src-tauri/target/{release,debug}"

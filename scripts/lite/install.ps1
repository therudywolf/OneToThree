# OneToThree Lite — guided installer (Windows).
# Run from a repo checkout:  powershell -ExecutionPolicy Bypass -File scripts\lite\install.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

foreach ($cmd in 'docker', 'node') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "[!] $cmd is required." -ForegroundColor Red
    exit 1
  }
}
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Write-Host '[!] Docker Compose v2 is required (docker compose).' -ForegroundColor Red; exit 1 }

& node scripts/lite/install.mjs
exit $LASTEXITCODE

# OneToThree Lite — launch the graphical setup wizard (Windows).
#   powershell -ExecutionPolicy Bypass -File scripts\lite\lite-gui.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is required (https://nodejs.org)'; exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host '! Docker not found - the wizard opens, but you need Docker Desktop to launch the stack.'
} else {
  try { docker compose version | Out-Null } catch {
    Write-Host '! Docker Compose v2 not found - install/upgrade Docker Desktop.'
  }
}

node scripts\lite\wizard\server.mjs @args

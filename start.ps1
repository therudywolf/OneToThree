param(
  [Parameter(Position = 0)]
  [string]$Command = "help",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$ApkBuilder = Join-Path $Root "scripts/build-apk.ps1"

switch ($Command) {
  "build-apk" {
    & $ApkBuilder @Args
    exit $LASTEXITCODE
  }
  "build-apk-release" {
    & $ApkBuilder "release" @Args
    exit $LASTEXITCODE
  }
  default {
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  .\start.ps1 build-apk"
    Write-Host "  .\start.ps1 build-apk-release <keystore-path>"
    Write-Host ""
    Write-Host "Linux/macOS launcher remains in ./start.sh."
    exit 1
  }
}

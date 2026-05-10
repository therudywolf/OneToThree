#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a fresh Android APK and places it in releases/android.

.DESCRIPTION
  Thin Windows convenience wrapper for Android APK builds. Production stack
  commands stay on ./startup.sh and require only Docker on the host.

.EXAMPLE
  .\apkbuild.ps1

.EXAMPLE
  .\apkbuild.ps1 -Release -KeystorePath C:\keys\onetothree.jks
#>

param(
  [switch]$Release,
  [string]$KeystorePath = "",
  [string]$OutputName = "",
  [switch]$NoVersionedCopy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot

function Fail([string]$Message) {
  Write-Host "[ERR] $Message" -ForegroundColor Red
  exit 1
}

function Write-Step([string]$Message) {
  Write-Host "[APK] $Message" -ForegroundColor Cyan
}

$commandArgs = @()
if ($Release) {
  $commandArgs += "release"
  if ([string]::IsNullOrWhiteSpace($KeystorePath)) {
    Fail "Release build requires -KeystorePath C:\path\to\keystore.jks"
  }
  $commandArgs += $KeystorePath
} else {
  $commandArgs += "debug"
}

$envBackup = @{
  APK_OUTPUT_NAME = $env:APK_OUTPUT_NAME
  APK_NO_VERSIONED_COPY = $env:APK_NO_VERSIONED_COPY
}

try {
  if (-not [string]::IsNullOrWhiteSpace($OutputName)) {
    $env:APK_OUTPUT_NAME = $OutputName
  }

  if ($NoVersionedCopy) {
    $env:APK_NO_VERSIONED_COPY = "1"
  }

  Write-Step "Building APK..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts/build-apk.ps1") @commandArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  Write-Step "Done. APK artifacts are in releases/android."
} finally {
  foreach ($key in $envBackup.Keys) {
    $old = $envBackup[$key]
    if ($null -eq $old) {
      Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$key" -Value $old
    }
  }
}

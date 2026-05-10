#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a fresh Android APK and places it in releases/android.

.DESCRIPTION
  Thin Windows convenience wrapper for the project startup flow. It keeps the
  build procedure centralized by delegating to scripts/start.mjs, the same
  dispatcher used by ./startup.sh.

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

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js not found in PATH. Install Node.js 20+ first."
}

$commandArgs = @()
if ($Release) {
  $commandArgs += "build-apk-release"
  if ([string]::IsNullOrWhiteSpace($KeystorePath)) {
    Fail "Release build requires -KeystorePath C:\path\to\keystore.jks"
  }
  $commandArgs += $KeystorePath
} else {
  $commandArgs += "build-apk"
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

  Write-Step "Delegating to startup build flow..."
  & node (Join-Path $Root "scripts/start.mjs") @commandArgs
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

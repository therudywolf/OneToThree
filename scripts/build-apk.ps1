param(
  [Parameter(Position = 0)]
  [ValidateSet("debug", "release")]
  [string]$BuildType = "debug",

  [Parameter(Position = 1)]
  [string]$KeystorePath,

  [string]$OutputName = "",

  [switch]$NoVersionedCopy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ClientDir = Join-Path $Root "client"
$CapDir = Join-Path $Root "mobile/capacitor"
$AndroidDir = Join-Path $CapDir "android"
$EnvFile = Join-Path $Root ".env.prod"

function Write-Info([string]$Message) {
  Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-Ok([string]$Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Fail([string]$Message) {
  Write-Host "[ERR] $Message" -ForegroundColor Red
  exit 1
}

function Assert-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail $Hint
  }
}

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) {
    return ""
  }

  $line = Get-Content -Path $Path | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))=" } | Select-Object -First 1
  if (-not $line) {
    return ""
  }

  $value = $line.Substring($line.IndexOf("=") + 1)
  # Strip inline " # comment" — .env.prod keeps human annotations after values
  # but build-time interpolation must not bake them into NEXT_PUBLIC_* vars.
  $value = $value -replace '\s+#.*$', ''
  return $value.Trim().Trim('"').Trim()
}

function Invoke-Step([string]$Exe, [string[]]$CommandArgs) {
  & $Exe @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    $argsList = @($CommandArgs)
    $joinedArgs = ""
    if ($argsList.Count -gt 0) {
      $joinedArgs = [string]::Join(" ", $argsList)
    }
    $joined = if ([string]::IsNullOrWhiteSpace($joinedArgs)) { $Exe } else { "$Exe $joinedArgs" }
    Fail "Command failed: $joined"
  }
}

function Get-GitShortSha {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    return "nogit"
  }

  $sha = & git -C $Root rev-parse --short=8 HEAD 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) {
    return "nogit"
  }

  return $sha.Trim()
}

function Copy-ApkArtifact([string]$SourceApk, [string]$ReleaseDir, [string]$Kind, [string]$NameOverride, [bool]$SkipVersionedCopy) {
  if (-not (Test-Path $ReleaseDir)) {
    New-Item -ItemType Directory -Path $ReleaseDir | Out-Null
  }

  $stableName = if ([string]::IsNullOrWhiteSpace($NameOverride)) { "onetothree-$Kind.apk" } else { $NameOverride }
  if (-not $stableName.EndsWith(".apk", [StringComparison]::OrdinalIgnoreCase)) {
    $stableName = "$stableName.apk"
  }

  $stablePath = Join-Path $ReleaseDir $stableName
  Copy-Item -Path $SourceApk -Destination $stablePath -Force

  $artifactPaths = @($stablePath)
  if (-not $SkipVersionedCopy) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmm"
    $sha = Get-GitShortSha
    $versionedPath = Join-Path $ReleaseDir "onetothree-$Kind-$stamp-$sha.apk"
    Copy-Item -Path $SourceApk -Destination $versionedPath -Force
    $artifactPaths += $versionedPath
  }

  foreach ($artifact in $artifactPaths) {
    $hash = Get-FileHash -Algorithm SHA256 -Path $artifact
    Set-Content -Path "$artifact.sha256" -Value "$($hash.Hash.ToLowerInvariant())  $(Split-Path -Leaf $artifact)" -Encoding ascii
  }

  return $artifactPaths
}

Assert-Command -Name "java" -Hint "Java not found. Install JDK 17+ and set JAVA_HOME."
Assert-Command -Name "node" -Hint "Node.js not found in PATH."
Assert-Command -Name "npm" -Hint "npm not found in PATH."

if ([string]::IsNullOrWhiteSpace($OutputName) -and -not [string]::IsNullOrWhiteSpace($env:APK_OUTPUT_NAME)) {
  $OutputName = $env:APK_OUTPUT_NAME
}

if (-not $NoVersionedCopy.IsPresent -and $env:APK_NO_VERSIONED_COPY -eq "1") {
  $NoVersionedCopy = $true
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
  Fail "ANDROID_HOME or ANDROID_SDK_ROOT must be set."
}

$ApiUrl = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_API_URL"
$AppUrl = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_APP_URL"
$VapidKey = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_VAPID_PUBLIC_KEY"
$TurnUrls = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_TURN_URLS"
$TurnUser = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_TURN_USERNAME"
$TurnPass = Get-EnvValue -Path $EnvFile -Key "NEXT_PUBLIC_TURN_PASSWORD"

if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
  Fail "NEXT_PUBLIC_API_URL missing in .env.prod. Run startup.sh first and configure env."
}

if ([string]::IsNullOrWhiteSpace($AppUrl)) {
  $AppUrl = $ApiUrl
}

Write-Info "API URL: $ApiUrl"
Write-Info "Building $BuildType APK..."

$envBackup = @{
  NEXT_EXPORT = $env:NEXT_EXPORT
  NEXT_PUBLIC_API_URL = $env:NEXT_PUBLIC_API_URL
  NEXT_PUBLIC_APP_URL = $env:NEXT_PUBLIC_APP_URL
  NEXT_PUBLIC_WS_ORIGIN = $env:NEXT_PUBLIC_WS_ORIGIN
  NEXT_PUBLIC_VAPID_PUBLIC_KEY = $env:NEXT_PUBLIC_VAPID_PUBLIC_KEY
  NEXT_PUBLIC_TURN_URLS = $env:NEXT_PUBLIC_TURN_URLS
  NEXT_PUBLIC_TURN_USERNAME = $env:NEXT_PUBLIC_TURN_USERNAME
  NEXT_PUBLIC_TURN_PASSWORD = $env:NEXT_PUBLIC_TURN_PASSWORD
}

try {
  Write-Info "Step 1/3: Next.js build..."
  Push-Location $ClientDir
  # Wipe any prior export first so stale pages (e.g. a route removed in a later
  # commit) can never be packaged into the APK.
  Write-Info "Cleaning previous Next.js export (client/out, client/.next)..."
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ClientDir "out")
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $ClientDir ".next")
  $env:NEXT_EXPORT = "1"
  $env:NEXT_PUBLIC_API_URL = $ApiUrl
  $env:NEXT_PUBLIC_APP_URL = $AppUrl
  $env:NEXT_PUBLIC_WS_ORIGIN = $ApiUrl
  $env:NEXT_PUBLIC_VAPID_PUBLIC_KEY = $VapidKey
  $env:NEXT_PUBLIC_TURN_URLS = $TurnUrls
  $env:NEXT_PUBLIC_TURN_USERNAME = $TurnUser
  $env:NEXT_PUBLIC_TURN_PASSWORD = $TurnPass
  Invoke-Step -Exe "npm" -CommandArgs @("exec", "--", "next", "build", "--webpack")
  Pop-Location
  Write-Ok "Next.js build complete."

  Write-Info "Step 2/3: Capacitor sync..."
  Push-Location $CapDir
  Invoke-Step -Exe "npm" -CommandArgs @("exec", "--", "cap", "sync", "android")
  Pop-Location
  Write-Ok "Capacitor sync complete."

  Write-Info "Step 3/3: Gradle assemble..."
  Push-Location $AndroidDir

  if ($BuildType -eq "release") {
    if ([string]::IsNullOrWhiteSpace($KeystorePath)) {
      Fail "Release build requires keystore path: .\scripts\build-apk.ps1 release C:\path\to\keystore.jks"
    }

    $resolvedKeystore = (Resolve-Path $KeystorePath -ErrorAction SilentlyContinue)
    if (-not $resolvedKeystore) {
      Fail "Keystore not found: $KeystorePath"
    }

    if ([string]::IsNullOrWhiteSpace($env:RELEASE_STORE_PASSWORD)) {
      Fail "RELEASE_STORE_PASSWORD is required for release build."
    }

    $releaseAlias = if ([string]::IsNullOrWhiteSpace($env:RELEASE_KEY_ALIAS)) { "p13release" } else { $env:RELEASE_KEY_ALIAS }
    $releaseKeyPassword = if ([string]::IsNullOrWhiteSpace($env:RELEASE_KEY_PASSWORD)) { $env:RELEASE_STORE_PASSWORD } else { $env:RELEASE_KEY_PASSWORD }

    Invoke-Step -Exe ".\gradlew.bat" -CommandArgs @(
      "assembleRelease",
      "-PRELEASE_STORE_FILE=$($resolvedKeystore.Path)",
      "-PRELEASE_STORE_PASSWORD=$($env:RELEASE_STORE_PASSWORD)",
      "-PRELEASE_KEY_ALIAS=$releaseAlias",
      "-PRELEASE_KEY_PASSWORD=$releaseKeyPassword"
    )
    $apkPath = Join-Path $AndroidDir "app/build/outputs/apk/release/app-release.apk"
  } else {
    Invoke-Step -Exe ".\gradlew.bat" -CommandArgs @("assembleDebug")
    $apkPath = Join-Path $AndroidDir "app/build/outputs/apk/debug/app-debug.apk"
  }

  Pop-Location

  if (-not (Test-Path $apkPath)) {
    Fail "APK not found at: $apkPath"
  }

  $ReleasesDir = Join-Path $Root "releases/android"
  $artifacts = Copy-ApkArtifact -SourceApk $apkPath -ReleaseDir $ReleasesDir -Kind $BuildType -NameOverride $OutputName -SkipVersionedCopy:$NoVersionedCopy.IsPresent
  foreach ($artifact in $artifacts) {
    Write-Ok "APK ready: $artifact"
    Write-Ok "SHA256 : $artifact.sha256"
  }
} finally {
  if ((Get-Location).Path -ne $Root) {
    Set-Location $Root
  }

  foreach ($key in $envBackup.Keys) {
    $old = $envBackup[$key]
    if ($null -eq $old) {
      Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$key" -Value $old
    }
  }
}

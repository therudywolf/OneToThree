#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the OneToThree APK on a connected Android device via ADB.

.DESCRIPTION
    Finds the latest OneToThree APK in the same directory, checks for a
    connected Android device, and installs the APK over ADB.
    Works from Windows PowerShell 5.1+ or PowerShell 7+.

.PARAMETER ApkPath
    Optional explicit path to the APK. Defaults to the newest
    onetothree-*.apk / OneToThree-*.apk in this script's folder.

.PARAMETER DeviceSerial
    Optional ADB device serial (use when multiple devices are connected).
    If omitted and multiple devices are found, the script prompts you to choose.

.EXAMPLE
    .\install-apk.ps1
    .\install-apk.ps1 -ApkPath ".\onetothree-release.apk"
    .\install-apk.ps1 -DeviceSerial "emulator-5554"
#>

param(
    [string]$ApkPath    = "",
    [string]$DeviceSerial = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── helpers ──────────────────────────────────────────────────────────────────

function Write-Step  { param([string]$msg) Write-Host "  > $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$msg) Write-Host "  [X] $msg"  -ForegroundColor Red }

function Exit-WithError {
    param([string]$msg)
    Write-Fail $msg
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# ── banner ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  OneToThree — Android APK Installer" -ForegroundColor White
Write-Host "  ────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ── 1. Locate ADB ────────────────────────────────────────────────────────────

Write-Step "Locating ADB..."

$adb = $null

# Try PATH first
$adbInPath = Get-Command adb -ErrorAction SilentlyContinue
if ($adbInPath) {
    $adb = $adbInPath.Source
}

# Common Windows SDK locations
if (-not $adb) {
    $sdkCandidates = @(
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$env:PROGRAMFILES\Android\Android Studio\platform-tools\adb.exe",
        "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe",
        "C:\Android\platform-tools\adb.exe",
        "C:\Program Files\Android\platform-tools\adb.exe"
    )
    foreach ($candidate in $sdkCandidates) {
        if (Test-Path $candidate) {
            $adb = $candidate
            break
        }
    }
}

if (-not $adb) {
    Exit-WithError @"
ADB not found. Install Android platform-tools:
  https://developer.android.com/tools/releases/platform-tools
Then either add platform-tools to your PATH or re-run after installation.
"@
}

Write-Ok "ADB: $adb"
$adbVersion = & $adb version 2>&1 | Select-String "Android Debug Bridge"
Write-Ok "$adbVersion"

# ── 2. Find APK ──────────────────────────────────────────────────────────────

Write-Step "Finding APK..."

if ($ApkPath -and (Test-Path $ApkPath)) {
    $apkFile = Get-Item $ApkPath
} else {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $apkFiles  = Get-ChildItem -Path $scriptDir -Filter "*.apk" -File |
                 Where-Object { $_.Name -match "(?i)(onetothree|OneToThree)" } |
                 Sort-Object LastWriteTime -Descending

    if ($apkFiles.Count -eq 0) {
        Exit-WithError "No OneToThree APK found in $scriptDir"
    }

    if ($apkFiles.Count -gt 1) {
        Write-Warn "Multiple APKs found — using newest:"
        $apkFiles | ForEach-Object { Write-Host "      $($_.Name)  ($($_.LastWriteTime.ToString('yyyy-MM-dd')))" -ForegroundColor DarkGray }
    }

    $apkFile = $apkFiles[0]
}

$apkSizeMB = [math]::Round($apkFile.Length / 1MB, 1)
Write-Ok "APK : $($apkFile.Name)  (${apkSizeMB} MB)"

# ── 3. Start ADB server + list devices ───────────────────────────────────────

Write-Step "Checking connected devices..."

# Start server silently so first-run delay doesn't confuse output
& $adb start-server 2>&1 | Out-Null

# Parse `adb devices` output — skip header line and empty lines
$rawDevices = & $adb devices 2>&1
$deviceLines = $rawDevices |
    Select-String "^\S+\s+(device|unauthorized|offline)" |
    ForEach-Object { $_.Line.Trim() }

if ($deviceLines.Count -eq 0) {
    Write-Warn "No devices found. Check that:"
    Write-Host "    1. USB debugging is enabled (Settings → Developer options → USB debugging)" -ForegroundColor DarkGray
    Write-Host "    2. The USB cable is connected and you accepted the RSA fingerprint prompt" -ForegroundColor DarkGray
    Write-Host "    3. Or start an Android emulator" -ForegroundColor DarkGray
    Write-Host ""
    Exit-WithError "Connect a device or emulator and re-run."
}

# Check for unauthorized
$unauthorized = $deviceLines | Where-Object { $_ -match "unauthorized" }
if ($unauthorized) {
    Write-Warn "Device is unauthorized — unlock your phone and tap 'Allow' on the USB debugging prompt."
    Exit-WithError "Authorize USB debugging and re-run."
}

# Check for offline
$offline = $deviceLines | Where-Object { $_ -match "offline" }
if ($offline) {
    Write-Warn "Device is offline. Unplug and reconnect the USB cable."
    Exit-WithError "Reconnect the device and re-run."
}

# Parse serials
$serials = $deviceLines | ForEach-Object { ($_ -split "\s+")[0] }

if ($DeviceSerial) {
    if ($serials -notcontains $DeviceSerial) {
        Exit-WithError "Serial '$DeviceSerial' not found. Available: $($serials -join ', ')"
    }
    $targetSerial = $DeviceSerial
} elseif ($serials.Count -eq 1) {
    $targetSerial = $serials[0]
    Write-Ok "Device: $targetSerial"
} else {
    Write-Host ""
    Write-Host "  Multiple devices found:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $serials.Count; $i++) {
        # Try to get device model name
        $model = & $adb -s $serials[$i] shell getprop ro.product.model 2>$null
        if (-not $model) { $model = "(unknown)" }
        Write-Host "    [$($i+1)] $($serials[$i])  —  $($model.Trim())" -ForegroundColor Cyan
    }
    Write-Host ""
    $choice = Read-Host "  Enter number [1-$($serials.Count)]"
    $idx = [int]$choice - 1
    if ($idx -lt 0 -or $idx -ge $serials.Count) {
        Exit-WithError "Invalid choice."
    }
    $targetSerial = $serials[$idx]
    Write-Ok "Using device: $targetSerial"
}

# ── 4. Install ───────────────────────────────────────────────────────────────

Write-Host ""
Write-Step "Installing $($apkFile.Name) on $targetSerial..."
Write-Host "    (This may take 10-30 seconds)" -ForegroundColor DarkGray
Write-Host ""

$installOutput = & $adb -s $targetSerial install -r -d $apkFile.FullName 2>&1
$installStr    = $installOutput -join "`n"

if ($installStr -match "Success") {
    Write-Host ""
    Write-Ok "Installation successful!"
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host "    1. Open OneToThree on your device" -ForegroundColor DarkGray
    Write-Host "    2. On first launch, enter your server URL (e.g. https://chat.example.com)" -ForegroundColor DarkGray
    Write-Host "    3. Register or log in" -ForegroundColor DarkGray
} else {
    Write-Host ""
    Write-Fail "Installation failed. ADB output:"
    Write-Host $installStr -ForegroundColor DarkRed
    Write-Host ""

    if ($installStr -match "INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
        Write-Warn "Fix: Uninstall the existing app first:"
        Write-Host "       adb -s $targetSerial uninstall com.onetothree.app" -ForegroundColor DarkGray
    } elseif ($installStr -match "INSTALL_FAILED_VERSION_DOWNGRADE") {
        Write-Warn "Fix: Use -d flag is already set. Try uninstalling first:"
        Write-Host "       adb -s $targetSerial uninstall com.onetothree.app" -ForegroundColor DarkGray
    } elseif ($installStr -match "device offline") {
        Write-Warn "Device went offline. Reconnect and re-run."
    }

    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
Read-Host "Press Enter to close"

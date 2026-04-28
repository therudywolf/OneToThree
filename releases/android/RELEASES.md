# Android Releases

Pre-built debug APKs for local testing and sideloading.

## Quick install via PowerShell (Windows)

Requires a USB cable and USB debugging enabled on the device.

```powershell
# From this directory in PowerShell:
.\install-apk.ps1
```

The script auto-finds the newest APK, detects connected devices, and installs via ADB.
If ADB is not in PATH it searches common Android SDK locations automatically.

**First time setup:**
1. Enable Developer options on your Android device (tap Build number 7×).
2. Enable USB debugging (Settings → Developer options → USB debugging).
3. Connect via USB and tap "Allow" on the RSA key prompt on the phone.
4. Run `.\install-apk.ps1`.

## Manual install (any OS)

```bash
# Linux / macOS
adb install -r -d releases/android/OneToThree-debug-2026-04-27.apk

# Or sideload: transfer APK to device and open it
# Requires "Install from unknown sources" in Android settings
```

## Build your own

```bash
# Prerequisites: Java 17+, Android SDK, ANDROID_HOME set
./start.sh build-apk          # debug APK
./start.sh build-apk-release  # release APK (requires keystore)
```

The APK lands in this folder as `onetothree-debug.apk` / `onetothree-release.apk`.

See `docs/guides/android-release-runbook.md` for the full release process.

## Changelog

| File | Date | Notes |
|------|------|-------|
| OneToThree-debug-2026-04-27.apk | 2026-04-27 | Pinned sender ECDH key (DECRYPT_FAIL fix), LiveKit SFU, vault upgrade race fix |

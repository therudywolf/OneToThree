# Android Releases

Pre-built debug APKs for local testing and sideloading.

## How to install

1. Enable "Install from unknown sources" in Android settings.
2. Transfer the APK to your device (ADB, cable, or download).
3. Open the APK file on the device to install.
4. Configure the server URL on first launch.

## Build your own

```bash
# Prerequisites: Java 17+, Android SDK, ANDROID_HOME set
./start.sh build-apk          # debug APK
./start.sh build-apk-release  # release APK (requires keystore)
```

The APK is placed at `releases/android/OneToThree-<build-type>.apk` when built via `scripts/build-apk.sh`.

See `docs/guides/android-release-runbook.md` for the full release process.

## Changelog

| File | Date | Notes |
|------|------|-------|
| OneToThree-debug-2026-04-27.apk | 2026-04-27 | Pinned sender ECDH key (DECRYPT_FAIL fix), LiveKit SFU, vault upgrade race fix |

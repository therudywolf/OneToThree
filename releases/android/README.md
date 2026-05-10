# Android APK Releases

`apkbuild.ps1` and `./startup.sh build-apk` place fresh Android APK artifacts here.

Generated files are intended for GitHub Releases and repo handoff:

- `onetothree-debug.apk` or `onetothree-release.apk` is the latest stable filename.
- `onetothree-<type>-YYYYMMDD-HHMM-<gitsha>.apk` is the immutable build artifact.
- Every APK gets a matching `.sha256` checksum file.

Build from Windows:

```powershell
.\apkbuild.ps1
.\apkbuild.ps1 -Release -KeystorePath C:\keys\onetothree.jks
```

Build from Unix/WSL:

```bash
./startup.sh build-apk
./startup.sh build-apk-release /path/to/release.keystore
```

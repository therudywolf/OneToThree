# Release process

OneToThree ships from a single GitHub Actions workflow
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) that
produces a signed Android APK plus desktop bundles (Windows MSI/NSIS,
Linux deb/AppImage, macOS dmg) and attaches them to a draft GitHub
Release.

The workflow runs automatically when you push a tag that starts with
`v` (`v0.5.0`, `v1.0.0-rc1`, etc). A pre-release is auto-detected from
a `-` in the tag name (release candidates, alphas, betas).

## One-time setup

### 1. Generate the Android keystore

The keystore is the **single most important secret** of an Android
release. Lose it and you can never publish an update for the same
`applicationId` on the same Play Store listing — there is no
recovery. Treat the file like a private key.

```bash
keytool -genkeypair \
  -keystore onetothree-release.jks \
  -storetype JKS \
  -alias p13release \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=OneToThree, OU=Apps, O=therudywolf, L=Unknown, S=Unknown, C=RU"
```

The command will prompt for two passwords:

* **store password** — protects the keystore file
* **key password** — protects the key inside (use the same value
  as the store password unless you have a reason not to)

Store the `.jks` file and both passwords somewhere safe (1Password /
Bitwarden / hardware token). Make at least one offline backup.

### 2. Set GitHub repository secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 onetothree-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password from step 1 |
| `ANDROID_KEY_ALIAS` | `p13release` (or whatever `-alias` you used) |
| `ANDROID_KEY_PASSWORD` | the key password from step 1 |
| `RELEASE_NEXT_PUBLIC_API_URL` | e.g. `https://api.onetothree.ru` |
| `RELEASE_NEXT_PUBLIC_APP_URL` | e.g. `https://onetothree.ru` |
| `RELEASE_NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key from `.env.prod` |
| `RELEASE_NEXT_PUBLIC_TURN_URLS` | comma-separated TURN URIs (optional) |
| `RELEASE_NEXT_PUBLIC_TURN_USERNAME` | TURN username (optional) |
| `RELEASE_NEXT_PUBLIC_TURN_PASSWORD` | TURN credential (optional) |

The TURN secrets are baked into every signed APK / desktop bundle —
they are not "secret" in the cryptographic sense, only "build-time
configurable". Anyone with the published binary can extract them. Use
short-lived TURN credentials if that matters in your threat model.

To get a base64 of the keystore that fits cleanly into a GitHub
secret without line wrapping:

```bash
# Linux/macOS
base64 -w0 onetothree-release.jks
# macOS without -w0
base64 -i onetothree-release.jks | tr -d '\n'
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("onetothree-release.jks"))
```

### 3. (Optional) Desktop code signing

For a smooth Windows install experience you'll want a code signing
certificate (EV/OV from a CA like Sectigo or DigiCert). Without it,
SmartScreen blocks the installer until enough people install through
the warning. macOS .dmg likewise warns from Gatekeeper unless signed
with an Apple Developer ID and notarized.

These are not wired into the workflow yet — file an issue when you
have the certificates.

## Cutting a release

```bash
# 1. Update the version. VERSION (root) is the SINGLE SOURCE OF TRUTH — the client
#    bakes it via next.config.js, the server reads it, and the Android build derives
#    versionName/versionCode from it. Bump:
#    - VERSION (root)
#    - README.md + README.ru.md version badges, and add a CHANGELOG.md entry
#    - desktop/tauri/package.json
#    - desktop/tauri/src-tauri/Cargo.toml
#    - desktop/tauri/src-tauri/tauri.conf.json
#    (Cargo.lock's onetothree-tauri version regenerates on the next cargo/tauri build.)
#
#    DO NOT bump client/package.json, server/package.json, mobile/capacitor/package.json
#    — they are intentionally decoupled (stay 0.1.0) and are never read for the
#    user-facing version.
#
# 2. Commit and push the bumps.
git commit -am "chore(release): v0.10.0"
git push origin main

# 3. Tag and push.
git tag v0.10.0
git push origin v0.10.0
```

Within ~15 minutes the workflow will:

1. Build a signed `onetothree-release-*.apk` on Ubuntu.
2. Build Tauri bundles on Linux + Windows + macOS in parallel.
3. Generate a changelog from `git log <prev tag>..HEAD`.
4. Open a **draft** GitHub Release with all artifacts attached.

You then review the draft, edit the description if needed, and click
"Publish release". Pre-release tags (anything containing `-`, e.g.
`v0.5.0-rc1`) are flagged as pre-release automatically.

## Local release builds

Same flow, but signed locally:

```bash
# Linux / macOS / WSL
RELEASE_STORE_PASSWORD='...' \
RELEASE_KEY_ALIAS=p13release \
RELEASE_KEY_PASSWORD='...' \
./scripts/build-apk.sh release ~/keystores/onetothree-release.jks

# Windows
.\apkbuild.ps1 -Release -KeystorePath C:\keystores\onetothree-release.jks
```

The signed APK lands in `releases/android/`.

## Rollback

GitHub Releases are immutable once published, but you can:

* unpublish a release (it goes back to draft) and re-tag,
* roll the server back with `git revert <bad commit>` + redeploy via
  `~/sites/onetothree.ru` `docker compose up -d --build`.

The Android APK has no auto-update mechanism yet — users on the broken
build stay broken until they reinstall. The desktop client also has no
updater wired (planned: `tauri-plugin-updater`). Keep release cadence
slow until both are in place.

# OneToThree Android Capacitor Shell

Capacitor wrapper for Android release builds with native push lifecycle.

## Quick start

From repo root:

```bash
npm run android:build:debug
```

This command:

1. builds static web assets (`client/out`)
2. syncs assets into `mobile/capacitor/android`
3. builds `assembleDebug`

## iOS

The same Capacitor project also targets iOS (`@capacitor/ios` is wired in). iOS
can only be built on a Mac and is **not scaffolded yet** — the first build runs
`cap add ios`. Full instructions, signing, Universal Links, and the
`scripts/build-ipa.sh` helper live in
[`docs/BUILD_MACOS_IOS.md`](../../docs/BUILD_MACOS_IOS.md).

```bash
npm run ios:add     # one-time: scaffold mobile/capacitor/ios/ (Mac only)
./scripts/build-ipa.sh simulator   # or: archive (signed .ipa)
```

## FCM setup (optional)

FCM is **optional**. `google-services.json` is operator-supplied and is *not*
committed to the repo. The APK builds and runs fine without it — the build
applies the `com.google.gms.google-services` Gradle plugin only when the file
is present (see `app/build.gradle`). Without FCM, the app falls back to the
**Direct (foreground service)** notification mode, which needs no Google
transport. Only the `Google FCM push` mode requires the steps below.

1. Create Firebase Android app with package id `ru.onetothree.app`.
2. Place `google-services.json` into `mobile/capacitor/android/app/google-services.json`.
3. Configure backend secrets:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (or `*_FILE`)
   - or split fields: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`

## Deep links (App Links)

The app registers an `https` intent-filter for `https://onetothree.ru/join/...`
with `android:autoVerify="true"`, plus the legacy `onetothree://` custom scheme.
Verified App Links open invite/join links directly in the app instead of a
browser. For verification to succeed the server must publish
`https://onetothree.ru/.well-known/assetlinks.json` containing the release
keystore's SHA-256 certificate fingerprint. Until that file is live, Android
treats the filter as a normal (unverified) link handler — the app still appears
in the "open with" chooser. The JS side routes the incoming URL via the
Capacitor `App` plugin's `appUrlOpen` event (see
`client/src/components/native-deep-link.tsx`).

## Screen security (FLAG_SECURE)

`MainActivity` sets `WindowManager.LayoutParams.FLAG_SECURE` on the window so
decrypted E2EE content cannot be screenshotted, screen-recorded, or shown in
the recent-apps thumbnail. It is **on by default**; a `Privacy` Capacitor
plugin could toggle it at runtime (`client/src/lib/native-flag-secure.ts`).

## Release signing

Set Gradle properties (CLI `-P` or `android/gradle.properties`):

- `RELEASE_STORE_FILE`
- `RELEASE_STORE_PASSWORD`
- `RELEASE_KEY_ALIAS`
- `RELEASE_KEY_PASSWORD`
- `VERSION_CODE`
- `VERSION_NAME`

Build:

```bash
npm run android:build:release
```

## Notification routing contract

- Push payload must carry `chat_id` and `url` (e.g. `/?chat=<id>`).
- App listener maps push action to chat open flow for:
  - foreground
  - background
  - cold start (terminated)

## Notification modes in app

Android app supports two user-selectable delivery modes:

- `Direct (foreground service)`:
  - starts native foreground service,
  - avoids Google push transport,
  - uses more battery and shows ongoing system notification.
- `Google FCM push`:
  - uses Firebase token and standard push flow,
  - lower battery impact,
  - delivery metadata goes through Google infrastructure.

Default behavior: user must choose mode on first run.

## Theme parity expectation

Android WebView must keep the same theme behavior as Web/PWA:

- same persisted shell/palette selection,
- same runtime theme switching,
- same visual tokens for all supported themes.

## Native auth/session bridge

Android shell enables both native Capacitor cookie and HTTP bridges:

- `CapacitorCookies.enabled = true`
- `CapacitorHttp.enabled = true`

This keeps `fm_session` stable for cross-site API requests from the native WebView and avoids relying on brittle browser-managed third-party cookie behavior during login/device-link flows.

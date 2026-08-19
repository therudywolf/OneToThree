# Android Release Runbook

## 1) Preconditions

- Android SDK + Build Tools installed.
- JDK **21** configured. Capacitor 8 generates `sourceCompatibility 21`; on JDK 17 the build fails with `invalid source release: 21`.
- Firebase project created for `ru.onetothree.app`.
- Backend secrets for FCM configured.

### FCM push setup (owner action — the build does NOT fail without it)

`google-services.json` is per-project Firebase configuration and is gitignored,
so a clean checkout builds a perfectly healthy-looking APK that simply never
receives a push. The build prints a loud warning when the file is missing;
treat that warning as blocking for anything you hand to a user.

Both halves have to be configured, and they come from the SAME Firebase project:

1. **App half.** Firebase console → your project → add an Android app with the
   package name `ru.onetothree.app` → download `google-services.json` → place it
   at `mobile/capacitor/android/app/google-services.json`. Do not commit it.
2. **Server half.** Firebase console → Project settings → Service accounts →
   generate a private key, then give the API either
   `FIREBASE_SERVICE_ACCOUNT_JSON` (the whole JSON, simplest) or the trio
   `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`.
   All are read through the standard secret loader, so `*_FILE` works too — and
   on this deployment `secrets/*` must be `0644` (the api runs as uid 1001).
   Without them `sendNativePushToUser` silently no-ops.

Web Push (browsers/PWA) is independent of all this and keeps working — the gap
only affects native Android notifications.

## 2) Build and sync web assets

```bash
npm run build:client:export
npm run android:sync
```

## 3) Provide signing and versioning

Release properties:

- `RELEASE_STORE_FILE`
- `RELEASE_STORE_PASSWORD`
- `RELEASE_KEY_ALIAS`
- `RELEASE_KEY_PASSWORD`
- `VERSION_CODE` (increment each release)
- `VERSION_NAME` (semantic/app version)

Example:

```bash
cd mobile/capacitor/android
./gradlew assembleRelease \
  -PRELEASE_STORE_FILE=app/release.keystore \
  -PRELEASE_STORE_PASSWORD=*** \
  -PRELEASE_KEY_ALIAS=upload \
  -PRELEASE_KEY_PASSWORD=*** \
  -PVERSION_CODE=12 \
  -PVERSION_NAME=1.2.0
```

## 4) QA checklist

- App launches from cold start.
- Login/session restore works.
- Notification mode chooser appears on first run (Android native only).
- `Direct (foreground service)` mode:
  - foreground service starts and remains active,
  - persistent system notification is visible,
  - message notification flow works after app background/return.
- `Google FCM` mode:
  - token registers successfully,
  - push delivery works in foreground/background/terminated.
- Runtime mode switch works both ways (`Direct <-> FCM`) without duplicate notifications.
- Notification tap opens expected chat (`chat_id` routing).
- Offline send queue retries when back online.
- Message/read state remains consistent after kill/reopen.
- Theme parity check on Android matches Web/PWA:
  - shell mode and palette persist across restart,
  - runtime theme switch applies immediately,
  - no visual regressions for `terminal`, `md3`, `retro`, `cyberpunk2077`.

## 5) Play Store rollout

- Upload AAB/APK to Internal testing first.
- Validate crash-free and push reliability telemetry.
- Promote to closed beta, then production staged rollout.

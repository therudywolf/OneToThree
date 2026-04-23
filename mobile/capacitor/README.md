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

## FCM setup

1. Create Firebase Android app with package id `ru.onetothree.app`.
2. Place `google-services.json` into `mobile/capacitor/android/app/google-services.json`.
3. Configure backend secrets:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (or `*_FILE`)
   - or split fields: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`

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

# Android Release Runbook

## 1) Preconditions

- Android SDK + Build Tools installed.
- Java 17+ configured.
- Firebase project created for `ru.onetothree.app`.
- Backend secrets for FCM configured.

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
- Push delivery works in foreground/background/terminated.
- Notification tap opens expected chat (`chat_id` routing).
- Offline send queue retries when back online.
- Message/read state remains consistent after kill/reopen.

## 5) Play Store rollout

- Upload AAB/APK to Internal testing first.
- Validate crash-free and push reliability telemetry.
- Promote to closed beta, then production staged rollout.

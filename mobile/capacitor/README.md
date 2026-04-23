# Capacitor Phase (Mobile Production Shell)

This directory contains the bootstrap configuration for the native wrapper phase.

## Goals

- Stable background notifications when browser PWA restrictions apply.
- Better lifecycle handling (`foreground` / `background` / `terminated`).
- Native integration baseline: app icon, splash, status bar, haptics, share intent.

## Planned steps

1. Build web client for static output compatible with Capacitor webDir.
2. Initialize Capacitor runtime and add `android` / `ios` platforms.
3. Wire native push token registration to backend push routes.
4. Connect notification tap deep-links to open chat by `chat_id`.
5. Add telemetry for delivery/open rates and background failures.

## Notes

- Current PWA flow remains primary until native shell is validated in beta.
- This scaffold is intentionally minimal and non-breaking for existing web builds.

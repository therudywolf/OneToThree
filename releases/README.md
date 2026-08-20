# Release artifacts

Built installers and packages for the OneToThree clients. Per ADR-001 the
client strategy is one Next.js web codebase wrapped by Tauri 2 (desktop)
and Capacitor (mobile).

## Layout

- `desktop/` — Tauri bundles: `.msi` / `.exe` (Windows), `.dmg` (macOS),
  `.deb` / `.AppImage` (Linux).
  Source: `desktop/tauri/src-tauri/target/release/bundle/`.
- `android/` — Capacitor `.apk` / `.aab`.
  Source: `mobile/capacitor/android/app/build/outputs/`.
- `ios/` — Capacitor `.ipa`. Empty, and expected to stay so: the iOS target
  has not been added (see `docs/BUILD_MACOS_IOS.md`).

## Convention

Copy a finished build here as
`<platform>/OneToThree-<version>-<target>.<ext>`, e.g.
`desktop/OneToThree-0.5.0-alpha.1-x64.msi`.

The binaries themselves are git-ignored (see `.gitignore`) — only this
folder structure is tracked. Distribute releases via GitHub Releases, not
the repository.

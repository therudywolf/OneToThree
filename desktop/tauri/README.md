# OneToThree desktop (Tauri 2)

Native shell for Windows / Linux / macOS. Reuses the same Next.js static
export (`client/out/`) that powers the Capacitor Android APK, so there is
**one** client codebase for every platform.

## Why Tauri

- 5–10 MB final binary (vs ~80 MB Electron) — uses the OS WebView2 / WebKit-GTK / WKWebView.
- Native push notifications, deep-links (`onetothree://join/<code>`), and an
  **OS keychain bridge** so the vault wrap key can live in Windows
  Credential Manager / GNOME Keyring / KWallet / macOS Keychain instead
  of IndexedDB.
- **Single-instance** guard: a second launch (including one triggered by
  the OS opening an `onetothree://` link) focuses the running window
  instead of spawning a duplicate process.
- The frontend is already a static export, so no build-time changes
  are required to the client.

## Prerequisites

- Node.js ≥ 20 (already required by the monorepo).
- Rust toolchain (`rustup install stable`).
- Platform deps:
  - **Windows**: WebView2 Runtime (preinstalled on Win11), MSVC build tools.
  - **Linux (Debian/Ubuntu)**: `sudo apt install -y libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev build-essential`.
  - **macOS**: Xcode CLT (`xcode-select --install`).

## Layout

```
desktop/tauri/
├── package.json           # JS deps (CLI + @tauri-apps/api)
└── src-tauri/
    ├── Cargo.toml         # Rust crate
    ├── tauri.conf.json    # window, CSP, bundle targets, deep-link scheme
    ├── capabilities/      # ACL for IPC commands
    ├── icons/             # app icon set — committed, see below
    └── src/
        ├── main.rs
        ├── lib.rs         # tauri::Builder + plugins
        └── keychain.rs    # OS keychain IPC commands
```

## First-time setup

```
cd desktop/tauri
npm install
```

The app icon set (`src-tauri/icons/`) is **committed** — a fresh checkout
builds with no extra steps. The icons are derived from
`client/public/wolf-logo.png`; to regenerate them after the logo changes:

```
npx @tauri-apps/cli icon ../../client/public/wolf-logo.png
```

(`.gitignore` tracks only the six files Tauri's bundler needs —
`icon.png`, `icon.ico`, `icon.icns`, `32x32.png`, `128x128.png`,
`128x128@2x.png` — and ignores any extra Store-logo PNGs the command
emits.)

## Develop

```
npm run dev          # builds client/out + tauri dev
```

## Build installers

```
npm run build:bundles
# Linux:   src-tauri/target/release/bundle/{deb,appimage}/
# Windows: src-tauri/target/release/bundle/{msi,nsis}/
# macOS:   src-tauri/target/release/bundle/dmg/
```

## Frontend integration

The client can detect Tauri at runtime via `window.__TAURI_INTERNALS__`
and call the keychain bridge:

```ts
import { invoke } from '@tauri-apps/api/core'

async function unlockVaultViaKeychain(slotId: string) {
  const pin = await invoke<string | null>('keychain_get', { key: slotId })
  if (pin === null) return null
  // hand `pin` to the existing vault.unwrapPrivateJwkWithPin() flow
  return pin
}
```

The keychain entry is namespaced under service `ru.onetothree.app` and
keyed by the user's `node_id`, so multiple profiles on the same OS user
don't collide.

## CI

`.github/workflows/tauri-build.yml` builds a 3-platform matrix
(`ubuntu-22.04`, `windows-2022`, `macos-14`) on every push / PR that
touches `desktop/tauri/**` or `client/**`. It installs the toolchain,
generates icons, builds the static frontend, then runs `tauri build` and
uploads the bundles (`.deb` / `.AppImage` / `.msi` / `.exe` / `.dmg`) as
workflow artifacts. A manual `workflow_dispatch` run with `release: true`
also attaches them to a draft GitHub release.

## Code signing

Alpha builds are **unsigned** — Windows SmartScreen and macOS Gatekeeper
will warn on first launch. Signing, notarization, and the auto-updater
need platform secrets and are intentionally out of scope for the alpha;
they will be wired up before a stable release.

## Status

The desktop shell is **wired and buildable**, not just a scaffold:

- `lib.rs` registers the deep-link, notification, and single-instance
  plugins and exposes the keychain IPC commands.
- The keychain backend (`keychain.rs`) uses `keyring` v3 with explicit
  per-platform backends (macOS Keychain / Windows Credential Manager /
  Linux Secret Service).
- The client already has the matching adapter
  (`client/src/lib/native-keychain.ts`, with tests) — it no-ops on web
  and Capacitor Android and calls `invoke()` on Tauri desktop.
- The app icon set is committed, so `tauri build` works on a clean
  checkout and in CI.

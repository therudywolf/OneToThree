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
    ├── tauri.conf.json    # window, CSP, bundle targets
    ├── capabilities/      # ACL for IPC commands
    ├── icons/             # generated (see below)
    └── src/
        ├── main.rs
        ├── lib.rs         # tauri::Builder + plugins
        └── keychain.rs    # OS keychain IPC commands
```

## First-time setup

```
cd desktop/tauri
npm install
# generate platform icon set from the wolf logo
npx @tauri-apps/cli icon ../../client/public/wolf-logo.png
```

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

A GitHub Actions matrix (`.github/workflows/tauri-release.yml` — not yet
checked in) should build for `ubuntu-latest`, `windows-latest`, and
`macos-14`, then publish artifacts to a draft release.

## Status

This is the initial **scaffold**. The frontend has no Tauri-aware code
paths yet — the keychain bridge is wired and ready to use, and `tauri dev`
will boot the existing client unchanged. Next step is to add a thin
adapter in `client/src/lib/native-keychain.ts` that no-ops on web and
calls `invoke()` on desktop.

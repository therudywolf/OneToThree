//! OneToThree desktop shell.
//!
//! Wraps the same `client/out/` static export that powers the Capacitor
//! Android APK, exposing a small Rust IPC surface for OS-protected secret
//! storage (Windows Credential Manager / macOS Keychain / GNOME Keyring or
//! KWallet) and deep-link handling.

mod keychain;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
        ])
        .setup(|app| {
            // Register `onetothree://` as a deep-link scheme on platforms
            // where the plugin needs an explicit register call (Linux,
            // dev mode on macOS). On Windows + production macOS the
            // scheme is wired through the installer manifest.
            #[cfg(any(target_os = "linux", debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register("onetothree");
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OneToThree desktop");
}

//! OneToThree desktop shell.
//!
//! Wraps the same `client/out/` static export that powers the Capacitor
//! Android APK, exposing a small Rust IPC surface for OS-protected secret
//! storage (Windows Credential Manager / macOS Keychain / GNOME Keyring or
//! KWallet) and deep-link handling.

mod keychain;

use tauri::Manager;

/// Bring the existing main window to the foreground.
///
/// Invoked when a second process is launched (e.g. the OS opening an
/// `onetothree://` deep link). The single-instance plugin already aborted
/// that second process; here we just surface the running window.
#[cfg(desktop)]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The single-instance plugin MUST be the first one registered so a
    // duplicate launch is detected before any other initialisation runs.
    // It is desktop-only — on mobile a second launch can't happen.
    // The `deep-link` feature forwards an `onetothree://` URL opened by a
    // second process to the already-running instance's deep-link handler.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        focus_main_window(app);
    }));

    builder
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

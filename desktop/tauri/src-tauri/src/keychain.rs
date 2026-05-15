//! OS keychain bridge.
//!
//! Backs onto `keyring` (cross-platform), which selects:
//!   - Windows: Credential Manager
//!   - macOS:   Keychain
//!   - Linux:   Secret Service (GNOME Keyring / KWallet via D-Bus)
//!
//! The client uses this to store the vault PIN — or a randomly generated
//! wrap key — under the user's OS-protected account so the browser's
//! IndexedDB never holds the unlock secret. The frontend calls these
//! commands via `invoke('keychain_get', { key })` etc.
//!
//! Keys are namespaced with the app identifier so multiple OneToThree
//! profiles on the same OS user don't collide.

use serde::Serialize;
use thiserror::Error;

const SERVICE: &str = "ru.onetothree.app";

#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("keychain entry not found")]
    NotFound,
    #[error("keychain backend error: {0}")]
    Backend(String),
}

impl Serialize for KeychainError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn entry(key: &str) -> Result<keyring::Entry, KeychainError> {
    keyring::Entry::new(SERVICE, key).map_err(|e| KeychainError::Backend(e.to_string()))
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, KeychainError> {
    let e = entry(&key)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(KeychainError::Backend(err.to_string())),
    }
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), KeychainError> {
    let e = entry(&key)?;
    e.set_password(&value)
        .map_err(|err| KeychainError::Backend(err.to_string()))
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), KeychainError> {
    let e = entry(&key)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(KeychainError::Backend(err.to_string())),
    }
}

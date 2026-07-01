package ru.onetothree.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keystore — thin Capacitor bridge over {@link SecureStore}. Persists small
 * secrets (the E2EE vault PIN) encrypted with a hardware-backed Android Keystore
 * AES-GCM key so the Android app can silently unlock the vault without
 * re-prompting for the PIN on every launch. Mirrors the Tauri OS-keychain
 * bridge (desktop/tauri/.../keychain.rs).
 *
 * The stored secret is the PIN, NOT the unwrapped private key — the caller still
 * unwraps the (localStorage) vault blob with it, so a stale or missing entry
 * simply falls back to the manual PIN prompt.
 *
 * JS side: window.Capacitor.Plugins.Keystore.{get,set,remove} — see
 * client/src/lib/native-keychain.ts.
 */
@CapacitorPlugin(name = "Keystore")
public class KeystorePlugin extends Plugin {
  @PluginMethod
  public void get(PluginCall call) {
    final String key = call.getString("key");
    if (key == null) {
      call.reject("key required");
      return;
    }
    final String value = SecureStore.get(getContext(), key);
    final JSObject out = new JSObject();
    // Absent "value" key is read as null on the JS side.
    if (value != null) {
      out.put("value", value);
    }
    call.resolve(out);
  }

  @PluginMethod
  public void set(PluginCall call) {
    final String key = call.getString("key");
    final String value = call.getString("value");
    if (key == null || value == null) {
      call.reject("key and value required");
      return;
    }
    try {
      SecureStore.set(getContext(), key, value);
      call.resolve();
    } catch (Exception e) {
      call.reject("keystore set failed: " + e.getMessage());
    }
  }

  @PluginMethod
  public void remove(PluginCall call) {
    final String key = call.getString("key");
    if (key == null) {
      call.reject("key required");
      return;
    }
    SecureStore.remove(getContext(), key);
    call.resolve();
  }
}

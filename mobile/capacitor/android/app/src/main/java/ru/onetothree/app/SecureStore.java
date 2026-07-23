package ru.onetothree.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * SecureStore — small-secret persistence backed by a hardware-backed Android
 * Keystore AES-GCM key. The AES key never leaves the Keystore (TEE/StrongBox
 * where available); only the {iv:ciphertext} is written to a private
 * SharedPreferences file, so the on-disk blob is useless off-device.
 *
 * Split out of {@link KeystorePlugin} (the thin Capacitor wrapper) so the crypto
 * is directly instrumented-testable against a real device/emulator Keystore —
 * see app/src/androidTest/.../SecureStoreTest.java. This is the vault-PIN path,
 * so it must be verified, not assumed.
 */
final class SecureStore {
  private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "onetothree_vault_secret_v1";
  private static final String PREFS = "onetothree_secure_store";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int GCM_TAG_BITS = 128;

  private SecureStore() {}

  /**
   * Returns the decrypted value for {@code key}, or {@code null} if absent or if
   * decryption fails (e.g. the Keystore key was invalidated / app data cleared).
   * A null return is the caller's cue to fall back to the manual PIN prompt.
   */
  static String get(Context ctx, String key) {
    final String stored = prefs(ctx).getString(key, null);
    if (stored == null) {
      return null;
    }
    try {
      return decrypt(stored);
    } catch (Exception e) {
      return null;
    }
  }

  /** Encrypts and persists {@code value} under {@code key}. Throws on failure. */
  static void set(Context ctx, String key, String value) throws Exception {
    prefs(ctx).edit().putString(key, encrypt(value)).apply();
  }

  /** Removes any stored value for {@code key}. */
  static void remove(Context ctx, String key) {
    prefs(ctx).edit().remove(key).apply();
  }

  private static SharedPreferences prefs(Context ctx) {
    return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private static SecretKey getOrCreateKey() throws Exception {
    final KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
    ks.load(null);
    try {
      final KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
      if (entry instanceof KeyStore.SecretKeyEntry) {
        return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
      }
    } catch (Exception e) {
      // The alias exists but its key material is unusable — getEntry throws
      // UnrecoverableKeyException / KeyStoreException instead of returning null
      // (Keymaster corruption after an OS update, or an OEM keystore wipe on a
      // lockscreen-credential change). Drop the dead alias so we self-heal by
      // regenerating below; the old ciphertext then fails to decrypt -> get()
      // returns null -> manual PIN prompt -> next set() re-stashes under the
      // fresh key, restoring silent unlock without an app-data wipe.
      try {
        ks.deleteEntry(KEY_ALIAS);
      } catch (Exception ignored) {
        /* best-effort */
      }
    }
    final KeyGenerator kg =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
    final KeyGenParameterSpec.Builder builder =
        new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256);
    // No setUserAuthenticationRequired: silent unlock must not need a per-use
    // biometric/lock prompt (matches the Tauri keychain UX). BUT require the
    // device to be unlocked to DECRYPT (API 28+), so the vault-PIN secret cannot
    // be recovered while the screen is locked — closing the locked-device /
    // forensic decryption path without hurting normal foreground unlock (#14).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setUnlockedDeviceRequired(true);
    }
    kg.init(builder.build());
    return kg.generateKey();
  }

  private static String encrypt(String plaintext) throws Exception {
    final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
    final byte[] iv = cipher.getIV();
    final byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
    return Base64.encodeToString(iv, Base64.NO_WRAP)
        + ":"
        + Base64.encodeToString(ct, Base64.NO_WRAP);
  }

  private static String decrypt(String packed) throws Exception {
    final int sep = packed.indexOf(':');
    if (sep < 0) {
      throw new IllegalArgumentException("malformed secure-store value");
    }
    final byte[] iv = Base64.decode(packed.substring(0, sep), Base64.NO_WRAP);
    final byte[] ct = Base64.decode(packed.substring(sep + 1), Base64.NO_WRAP);
    final Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
    return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
  }
}

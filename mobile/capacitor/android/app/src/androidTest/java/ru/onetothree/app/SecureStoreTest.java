package ru.onetothree.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.security.KeyStore;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Instrumented test — runs on a real device/emulator so it exercises the actual
 * Android Keystore (AES-GCM) + SharedPreferences round-trip used to persist the
 * E2EE vault PIN. This is the "don't ship unverified crypto" guard for D32.
 */
@RunWith(AndroidJUnit4.class)
public class SecureStoreTest {
  private static final String KEY = "vault-pin:test-user";
  private static final String PREFS = "onetothree_secure_store";
  private Context ctx;

  @Before
  public void setUp() {
    ctx = ApplicationProvider.getApplicationContext();
    SecureStore.remove(ctx, KEY);
  }

  @After
  public void tearDown() {
    SecureStore.remove(ctx, KEY);
  }

  @Test
  public void absentKeyReturnsNull() {
    assertNull(SecureStore.get(ctx, KEY));
  }

  @Test
  public void roundTrip() throws Exception {
    SecureStore.set(ctx, KEY, "1234-secret-pin");
    assertEquals("1234-secret-pin", SecureStore.get(ctx, KEY));
  }

  @Test
  public void unicodeRoundTrip() throws Exception {
    final String secret = "пароль-🔐-Ω";
    SecureStore.set(ctx, KEY, secret);
    assertEquals(secret, SecureStore.get(ctx, KEY));
  }

  @Test
  public void overwriteKeepsLatest() throws Exception {
    SecureStore.set(ctx, KEY, "first");
    SecureStore.set(ctx, KEY, "second");
    assertEquals("second", SecureStore.get(ctx, KEY));
  }

  @Test
  public void removeClearsValue() throws Exception {
    SecureStore.set(ctx, KEY, "x");
    SecureStore.remove(ctx, KEY);
    assertNull(SecureStore.get(ctx, KEY));
  }

  @Test
  public void storedBlobIsCiphertextNotPlaintext() throws Exception {
    SecureStore.set(ctx, KEY, "supersecretpin");
    final SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    final String raw = p.getString(KEY, null);
    assertNotNull(raw);
    // Must be "ivBase64:ciphertextBase64" and never contain the plaintext.
    assertTrue("blob must carry the iv:ct separator", raw.contains(":"));
    assertFalse("plaintext must not appear on disk", raw.contains("supersecretpin"));
  }

  @Test
  public void selfHealsAfterKeyAliasWiped() throws Exception {
    SecureStore.set(ctx, KEY, "before-wipe");
    assertEquals("before-wipe", SecureStore.get(ctx, KEY));
    // Simulate an OEM keystore wipe / corruption: drop the AES key alias out
    // from under the still-present ciphertext.
    final KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    ks.deleteEntry("onetothree_vault_secret_v1");
    // The old ciphertext is now undecryptable -> fail closed to null (no crash).
    assertNull(SecureStore.get(ctx, KEY));
    // A fresh set regenerates the key and restores silent unlock.
    SecureStore.set(ctx, KEY, "after-wipe");
    assertEquals("after-wipe", SecureStore.get(ctx, KEY));
  }

  @Test
  public void tamperedCiphertextFailsClosedToNull() throws Exception {
    SecureStore.set(ctx, KEY, "orig-pin");
    final SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    final String raw = p.getString(KEY, null);
    assertNotNull(raw);
    final int sep = raw.indexOf(':');
    final String ivPart = raw.substring(0, sep);
    final String ctPart = raw.substring(sep + 1);
    // Flip the first ciphertext char (stays valid base64) — the GCM auth tag
    // must reject it, so get() fails closed to null rather than returning junk.
    final char first = ctPart.charAt(0);
    final char flipped = first == 'A' ? 'B' : 'A';
    p.edit().putString(KEY, ivPart + ":" + flipped + ctPart.substring(1)).apply();
    assertNull(SecureStore.get(ctx, KEY));
  }
}

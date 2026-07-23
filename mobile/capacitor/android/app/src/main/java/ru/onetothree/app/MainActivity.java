package ru.onetothree.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.view.WindowManager;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;
import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(NotificationModePlugin.class);
    registerPlugin(DevicePermissionsPlugin.class);
    registerPlugin(KeystorePlugin.class);
    registerPlugin(CallServicePlugin.class);
    registerPlugin(PrivacyPlugin.class);
    super.onCreate(savedInstanceState);

    createFcmChannels();

    // FLAG_SECURE: block screenshots, screen-recording, and the recent-apps
    // thumbnail from capturing decrypted E2EE content. On by default — this is
    // a security-first messenger. A `Privacy` Capacitor plugin may still toggle
    // it at runtime (see client/src/lib/native-flag-secure.ts).
    getWindow().setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE);

    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    getWindow().setStatusBarColor(Color.TRANSPARENT);
    getWindow().setNavigationBarColor(Color.TRANSPARENT);

    // First-party cookies only. Native auth rides a Bearer token
    // (fm_native_token, see client/src/lib/native-session.ts) precisely because
    // the cross-site fm_session cookie is unreliable in a WebView — so accepting
    // THIRD-party cookies buys nothing and only widens the cookie attack surface
    // (tracking / cookie-CSRF from any cross-origin content the WebView loads).
    CookieManager cookieManager = CookieManager.getInstance();
    cookieManager.setAcceptCookie(true);
    if (getBridge() != null && getBridge().getWebView() != null) {
      cookieManager.setAcceptThirdPartyCookies(getBridge().getWebView(), false);
    }
    cookieManager.flush();
  }

  /**
   * FCM notifications from the server carry channelId "messages" / "calls"
   * (see server/src/lib/push.ts). On Android 8+ a notification posted to a
   * channel that was never created is silently dropped — so create them at
   * startup (issue #13).
   */
  private void createFcmChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    final NotificationManager manager =
      (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;

    final NotificationChannel messages = new NotificationChannel(
      "messages", "Messages", NotificationManager.IMPORTANCE_HIGH);
    messages.setDescription("New encrypted messages");
    manager.createNotificationChannel(messages);

    final NotificationChannel calls = new NotificationChannel(
      "calls", "Calls", NotificationManager.IMPORTANCE_HIGH);
    calls.setDescription("Incoming calls");
    calls.enableVibration(true);
    manager.createNotificationChannel(calls);
  }
}

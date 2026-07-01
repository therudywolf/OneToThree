package ru.onetothree.app;

import android.graphics.Color;
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
    super.onCreate(savedInstanceState);

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

    CookieManager cookieManager = CookieManager.getInstance();
    cookieManager.setAcceptCookie(true);
    if (getBridge() != null && getBridge().getWebView() != null) {
      cookieManager.setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }
    cookieManager.flush();
  }
}

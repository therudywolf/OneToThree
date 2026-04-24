package ru.onetothree.app;

import android.graphics.Color;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;
import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(NotificationModePlugin.class);
    registerPlugin(DevicePermissionsPlugin.class);
    super.onCreate(savedInstanceState);
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

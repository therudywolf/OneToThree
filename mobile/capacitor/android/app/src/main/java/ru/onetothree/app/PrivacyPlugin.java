package ru.onetothree.app;

import android.app.Activity;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Toggle the window FLAG_SECURE at runtime — blocks screenshots, screen
 * recording, and the recent-apps thumbnail from capturing decrypted E2EE
 * content. FLAG_SECURE is ON by default (set in MainActivity.onCreate); this
 * plugin backs the JS contract in client/src/lib/native-flag-secure.ts, which
 * was previously a silent no-op because no Privacy plugin existed (#17).
 */
@CapacitorPlugin(name = "Privacy")
public class PrivacyPlugin extends Plugin {
  @PluginMethod
  public void setSecure(PluginCall call) {
    final boolean secure = Boolean.TRUE.equals(call.getBoolean("secure", Boolean.TRUE));
    final Activity activity = getActivity();
    if (activity == null) {
      call.reject("no activity");
      return;
    }
    activity.runOnUiThread(() -> {
      if (secure) {
        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
      } else {
        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
      }
    });
    final JSObject out = new JSObject();
    out.put("secure", secure);
    call.resolve(out);
  }
}

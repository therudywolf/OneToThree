package ru.onetothree.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NotificationMode")
public class NotificationModePlugin extends Plugin {
  @PluginMethod
  public void startDirectForegroundService(PluginCall call) {
    final Context context = getContext();
    final Intent intent = new Intent(context, DirectNotificationService.class);
    intent.setAction(DirectNotificationService.ACTION_START);
    // Starting a FGS from the background (Android 12+) throws
    // ForegroundServiceStartNotAllowedException — never crash the process.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ContextCompat.startForegroundService(context, intent);
      } else {
        context.startService(intent);
      }
    } catch (Exception e) {
      final JSObject out = new JSObject();
      out.put("ok", false);
      out.put("error", e.getClass().getSimpleName());
      call.resolve(out);
      return;
    }
    final JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }

  @PluginMethod
  public void stopDirectForegroundService(PluginCall call) {
    final Context context = getContext();
    final Intent intent = new Intent(context, DirectNotificationService.class);
    intent.setAction(DirectNotificationService.ACTION_STOP);
    try {
      context.startService(intent);
    } catch (Exception ignored) {
      /* stopService below still tears the service down */
    }
    try {
      context.stopService(new Intent(context, DirectNotificationService.class));
    } catch (Exception ignored) {
      /* best-effort */
    }
    final JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }

  @PluginMethod
  public void getDirectForegroundServiceState(PluginCall call) {
    final JSObject out = new JSObject();
    out.put("running", DirectNotificationService.isRunning());
    call.resolve(out);
  }
}

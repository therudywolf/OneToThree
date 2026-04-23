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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ContextCompat.startForegroundService(context, intent);
    } else {
      context.startService(intent);
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
    context.startService(intent);
    context.stopService(new Intent(context, DirectNotificationService.class));
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

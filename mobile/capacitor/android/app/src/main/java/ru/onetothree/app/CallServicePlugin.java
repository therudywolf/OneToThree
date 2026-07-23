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

/** Start/stop the {@link CallForegroundService} from the web call layer (#3/#13). */
@CapacitorPlugin(name = "CallService")
public class CallServicePlugin extends Plugin {
  @PluginMethod
  public void start(PluginCall call) {
    final Context context = getContext();
    final Intent intent = new Intent(context, CallForegroundService.class);
    intent.setAction(CallForegroundService.ACTION_START);
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
  public void stop(PluginCall call) {
    final Context context = getContext();
    final Intent intent = new Intent(context, CallForegroundService.class);
    intent.setAction(CallForegroundService.ACTION_STOP);
    context.startService(intent);
    context.stopService(new Intent(context, CallForegroundService.class));
    final JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }
}

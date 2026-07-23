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
    // On Android 12+ starting a FGS while the app is in the background throws
    // ForegroundServiceStartNotAllowedException — and an incoming call often
    // arrives via FCM while backgrounded. Never let that crash the process:
    // resolve {ok:false} so the JS caller can degrade gracefully.
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
  public void stop(PluginCall call) {
    final Context context = getContext();
    final Intent intent = new Intent(context, CallForegroundService.class);
    intent.setAction(CallForegroundService.ACTION_STOP);
    // startService from the background can throw IllegalStateException; stopping
    // must never crash. stopService alone also delivers the teardown.
    try {
      context.startService(intent);
    } catch (Exception ignored) {
      /* stopService below still tears the service down */
    }
    try {
      context.stopService(new Intent(context, CallForegroundService.class));
    } catch (Exception ignored) {
      /* best-effort */
    }
    final JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }
}

package ru.onetothree.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
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
    // Android 14+ kills a microphone-typed FGS with SecurityException if
    // RECORD_AUDIO is not held — and it throws on the next main-loop tick, long
    // after this method has already resolved, so the failure was invisible to
    // JS. Fail here instead, where the caller can still see why.
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
        != PackageManager.PERMISSION_GRANTED) {
      final JSObject denied = new JSObject();
      denied.put("ok", false);
      denied.put("error", "RECORD_AUDIO");
      denied.put("running", CallForegroundService.isRunning());
      call.resolve(denied);
      return;
    }
    final Intent intent = new Intent(context, CallForegroundService.class);
    intent.setAction(CallForegroundService.ACTION_START);
    // The web layer knows whether the camera is live; the service cannot ask.
    // Calling start() again when that changes re-promotes with the new type.
    intent.putExtra(CallForegroundService.EXTRA_VIDEO, call.getBoolean("video", false));
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
      out.put("running", CallForegroundService.isRunning());
      call.resolve(out);
      return;
    }
    final JSObject out = new JSObject();
    // ok:true only means the start request was accepted. startForeground runs on
    // a later tick and can still fail, so the caller must poll getState() to
    // learn whether the service is actually holding the mic.
    out.put("ok", true);
    out.put("running", CallForegroundService.isRunning());
    call.resolve(out);
  }

  /** Poll target for the JS layer: did the FGS actually reach the foreground? */
  @PluginMethod
  public void getState(PluginCall call) {
    final JSObject out = new JSObject();
    out.put("running", CallForegroundService.isRunning());
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

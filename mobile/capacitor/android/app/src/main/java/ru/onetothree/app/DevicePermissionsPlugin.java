package ru.onetothree.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
  name = "DevicePermissions",
  permissions = {
    @Permission(strings = {Manifest.permission.CAMERA}, alias = "camera"),
    @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"),
    @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications"),
    @Permission(strings = {Manifest.permission.READ_MEDIA_IMAGES}, alias = "mediaImages"),
    @Permission(strings = {Manifest.permission.READ_MEDIA_VIDEO}, alias = "mediaVideo"),
    @Permission(strings = {Manifest.permission.READ_MEDIA_AUDIO}, alias = "mediaAudio"),
    @Permission(strings = {Manifest.permission.READ_EXTERNAL_STORAGE}, alias = "storageRead")
  }
)
public class DevicePermissionsPlugin extends Plugin {
  @PluginMethod
  public void requestEssentialPermissions(PluginCall call) {
    final List<String> required = new ArrayList<>();
    required.add("camera");
    required.add("microphone");
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      required.add("notifications");
      required.add("mediaImages");
      required.add("mediaVideo");
      required.add("mediaAudio");
    } else {
      required.add("storageRead");
    }

    final List<String> missing = new ArrayList<>();
    for (String alias : required) {
      if (getPermissionState(alias) != PermissionState.GRANTED) {
        missing.add(alias);
      }
    }

    if (missing.isEmpty()) {
      call.resolve(buildPermissionState(required));
      return;
    }
    requestPermissionForAliases(missing.toArray(new String[0]), call, "permissionRequestCallback");
  }

  @PluginMethod
  public void requestBackgroundExecution(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      JSObject out = new JSObject();
      out.put("supported", false);
      out.put("requested", false);
      out.put("ignoringBatteryOptimizations", true);
      call.resolve(out);
      return;
    }

    final String pkg = getContext().getPackageName();
    final PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
    final boolean alreadyIgnoring =
      pm != null && pm.isIgnoringBatteryOptimizations(pkg);

    JSObject out = new JSObject();
    out.put("supported", true);
    out.put("ignoringBatteryOptimizations", alreadyIgnoring);
    out.put("requested", false);

    if (alreadyIgnoring) {
      call.resolve(out);
      return;
    }

    try {
      final Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
      intent.setData(Uri.parse("package:" + pkg));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      out.put("requested", true);
    } catch (Exception ignored) {
      out.put("requested", false);
    }

    call.resolve(out);
  }

  @PermissionCallback
  private void permissionRequestCallback(PluginCall call) {
    final List<String> required = new ArrayList<>();
    required.add("camera");
    required.add("microphone");
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      required.add("notifications");
      required.add("mediaImages");
      required.add("mediaVideo");
      required.add("mediaAudio");
    } else {
      required.add("storageRead");
    }
    call.resolve(buildPermissionState(required));
  }

  private JSObject buildPermissionState(List<String> aliases) {
    JSObject out = new JSObject();
    JSObject states = new JSObject();
    boolean allGranted = true;
    JSArray missing = new JSArray();

    for (String alias : aliases) {
      boolean granted = getPermissionState(alias) == PermissionState.GRANTED;
      states.put(alias, granted ? "granted" : "denied");
      if (!granted) {
        allGranted = false;
        missing.put(alias);
      }
    }

    out.put("allGranted", allGranted);
    out.put("states", states);
    out.put("missing", missing);
    return out;
  }
}

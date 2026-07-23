package ru.onetothree.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Keeps a call alive while the app is backgrounded. WebRTC media runs inside the
 * WebView JS; on Android 12+ a backgrounded process WITHOUT a microphone-typed
 * foreground service loses live mic access (and the peer's audio drops) — see
 * issue #3 ("minimizing a call on Android loses the peer's audio"). The web call
 * layer starts this service on call-begin and stops it on call-end via
 * CallServicePlugin.
 */
public class CallForegroundService extends Service {
  public static final String ACTION_START = "ru.onetothree.app.call.START";
  public static final String ACTION_STOP = "ru.onetothree.app.call.STOP";
  public static final String CHANNEL_ID = "ongoing_call";
  public static final int NOTIFICATION_ID = 13014;
  private static volatile boolean running = false;

  public static boolean isRunning() {
    return running;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    createChannel();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    final String action = intent == null ? null : intent.getAction();
    // A sticky/system restart re-invokes onStartCommand with a null intent (no
    // ACTION_START) after the process was reclaimed. Re-promoting a
    // microphone-typed FGS then would show a bogus "mic in use" indicator with
    // no call running (and on Android 14+ can throw). Only start on an explicit
    // ACTION_START; anything else (null restart or ACTION_STOP) tears down.
    if (!ACTION_START.equals(action)) {
      running = false;
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
      return START_NOT_STICKY;
    }

    running = true;
    // Android 10+ requires the foregroundServiceType at start; 14+ additionally
    // requires the FOREGROUND_SERVICE_MICROPHONE permission (declared in the
    // manifest) AND that the start is currently permitted — startForeground can
    // throw ForegroundServiceStartNotAllowedException / SecurityException, so
    // fail closed (stop) rather than crashing the process.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          buildNotification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
      } else {
        startForeground(NOTIFICATION_ID, buildNotification());
      }
    } catch (Exception e) {
      running = false;
      stopSelf();
      return START_NOT_STICKY;
    }
    // NOT_STICKY: a call is a live session driven by the web layer; if the
    // process dies the call is already gone, so do not resurrect the service.
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    running = false;
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    final NotificationManager manager =
      (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return;
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
    final NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
    channel.setDescription("Shown while a call is active.");
    manager.createNotificationChannel(channel);
  }

  private Notification buildNotification() {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("OneToThree")
      .setContentText("Ongoing call")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .build();
  }
}

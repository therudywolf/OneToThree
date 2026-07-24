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

public class DirectNotificationService extends Service {
  public static final String ACTION_START = "ru.onetothree.app.direct.START";
  public static final String ACTION_STOP = "ru.onetothree.app.direct.STOP";
  public static final String CHANNEL_ID = "direct_mode_channel";
  public static final int NOTIFICATION_ID = 13013;
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
    // Only ever promote on an EXPLICIT ACTION_START. A null intent is what the
    // system delivers when it restarts a sticky service after reclaiming the
    // process — that restart happens in the background, and a background FGS
    // start is forbidden from Android 12+ (ForegroundServiceStartNotAllowedException).
    // Anything that is not ACTION_START (null restart or ACTION_STOP) tears down.
    if (!ACTION_START.equals(action)) {
      running = false;
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
      return START_NOT_STICKY;
    }

    running = true;
    // API 29+ requires the type at start; 34+ additionally enforces the matching
    // FOREGROUND_SERVICE_* permission. `specialUse` is the correct type here:
    // this service transfers NOTHING — it only holds the process at foreground
    // importance so the WebView's WebSocket (the no-Google notification
    // transport) stays connected. `dataSync` would be semantically wrong AND
    // subject to Android 15's 6h/24h quota, after which the system calls
    // onTimeout and then refuses further starts — silently killing direct mode.
    // Pre-34 releases have no specialUse constant and no quota, so dataSync is
    // used there; both types are declared in the manifest so neither start
    // mismatches the declaration.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          buildNotification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          buildNotification(),
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
      } else {
        startForeground(NOTIFICATION_ID, buildNotification());
      }
    } catch (Exception e) {
      // Fail closed instead of taking the process down. isRunning() then reports
      // false, and the web layer refuses to persist "direct" mode (so the user
      // is never told private mode is on while receiving nothing).
      running = false;
      stopSelf();
      return START_NOT_STICKY;
    }
    // NOT_STICKY: a sticky restart would be exactly the forbidden background
    // start above. Direct mode is re-armed by the web layer on next app open
    // (push-subscription.ts :: ensureDirectForegroundMode).
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
    final NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "Direct notifications",
      NotificationManager.IMPORTANCE_LOW
    );
    channel.setDescription("Keeps direct encrypted notification mode active.");
    manager.createNotificationChannel(channel);
  }

  private Notification buildNotification() {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("OneToThree direct mode")
      .setContentText("Direct encrypted notification channel is active")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build();
  }
}

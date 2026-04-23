package ru.onetothree.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
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
    if (ACTION_STOP.equals(action)) {
      running = false;
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
      return START_NOT_STICKY;
    }

    running = true;
    startForeground(NOTIFICATION_ID, buildNotification());
    return START_STICKY;
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

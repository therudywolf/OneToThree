package ru.onetothree.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(NotificationModePlugin.class);
    super.onCreate(savedInstanceState);
  }
}

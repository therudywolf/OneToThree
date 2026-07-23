# JDK 21: Capacitor 8's :capacitor-android module compiles with sourceCompatibility
# 21, so JDK 17 fails with "invalid source release: 21". AGP 8.13 supports JDK 21.
FROM eclipse-temurin:21-jdk-jammy

# ── System deps + Node 22 ────────────────────────────────────────────────────
# Node 22 LTS: the Capacitor 8 CLI hard-requires Node >= 22 (`npx cap sync`
# aborts on Node 20 with "requires NodeJS >=22.0.0"), so Node 20 never built.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip git ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Android SDK ──────────────────────────────────────────────────────────────
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=$ANDROID_HOME
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools/36.0.0

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -L \
       "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
       -o /tmp/cmdtools.zip \
    && unzip /tmp/cmdtools.zip -d /tmp \
    && mv /tmp/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdtools.zip

RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager \
         "platform-tools" \
         "platforms;android-36" \
         "build-tools;36.0.0" \
    && rm -rf "$ANDROID_HOME/.downloadIntermediates"

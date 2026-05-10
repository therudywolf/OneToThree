# OneToThree — Deploy, Update & Android

Practical guide: first deployment, updating production, and building the Android APK.

**[Русская версия → DEPLOY.ru.md](./DEPLOY.ru.md)**

---

## Table of Contents

- [First Deployment](#first-deployment)
  - [Requirements](#requirements)
  - [1 · Clone the repository](#1--clone-the-repository)
  - [2 · Set up DNS](#2--set-up-dns)
  - [3 · Open firewall ports](#3--open-firewall-ports)
  - [4 · Launch](#4--launch)
  - [5 · Create the first admin](#5--create-the-first-admin)
- [Updating](#updating)
  - [One-command update](#one-command-update)
  - [What happens internally](#what-happens-internally)
  - [Rollback](#rollback)
- [Android APK](#android-apk)
  - [Install a pre-built APK](#install-a-pre-built-apk)
  - [Build from source](#build-from-source)
  - [ADB install (Windows)](#adb-install-windows)

---

## First Deployment

### Requirements

| Resource | Minimum |
|----------|---------|
| OS | Linux (Ubuntu 22.04+ recommended) |
| CPU | 2 vCPU |
| RAM | 4 GB |
| Disk | 20 GB SSD |
| Docker | Engine 24+ with Compose v2 |
| Domain | 1 domain, 5 DNS A-records (see below) |

Install Docker if not present:

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # must be ≥ 2.x
```

---

### 1 · Clone the repository

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
```

---

### 2 · Set up DNS

Create **five** A-records pointing to your server IP:

| Record | Cloudflare proxy |
|--------|-----------------|
| `yourdomain.com` | Orange cloud (proxied) — OK |
| `api.yourdomain.com` | Orange cloud (proxied) — OK |
| `s3.yourdomain.com` | Orange cloud (proxied) — OK |
| `turn.yourdomain.com` | **Gray cloud — REQUIRED** |
| `lk.yourdomain.com` | **Gray cloud — REQUIRED** |

> `turn.*` and `lk.*` **must not** be proxied by Cloudflare. The Cloudflare
> proxy drops UDP packets — TURN relay and LiveKit media will not work behind it.

---

### 3 · Open firewall ports

```bash
# HTTP + HTTPS (Caddy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# TURN / STUN relay (coturn)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp

# LiveKit SFU media + ICE/TCP fallback
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp

sudo ufw reload
```

---

### 4 · Launch

```bash
chmod +x ./startup.sh
./startup.sh
```

The script does everything on first run:

1. Checks that Docker, openssl, curl are installed
2. Asks for your domain, ACME email, server public IP, and VAPID contact email
3. **Auto-generates all secrets** — DB password, MinIO password, JWT, TURN password, VAPID key pair, LiveKit API key/secret
4. Writes `.env.prod` with all required values (including `DOMAIN=` for Caddyfile)
5. Builds and starts 8 containers: Caddy, Next.js, Fastify API, PostgreSQL, Redis, MinIO, coturn, LiveKit
6. Waits for health checks to pass
7. **Shows credentials once** — copy them to a password manager immediately

> First run takes 3–7 minutes (Docker image pulls + TLS certificate from Let's Encrypt).

---

### 5 · Create the first admin

1. Open `https://yourdomain.com` in a browser
2. Register a new account
3. Promote it to admin:

```bash
docker exec -it forestmessenger-db-1 psql -U forest -d forest \
  -c "UPDATE users SET role='admin' WHERE username='YOUR_USERNAME';"
```

4. Log out and back in, then open `/admin`

---

## Updating

### One-command update

```bash
# Optional but recommended: back up first
./startup.sh backup

# Update
./startup.sh update
```

Takes 2–5 minutes. Your data is safe — databases and media live in Docker
named volumes that are never touched by image rebuilds.

---

### What happens internally

`./startup.sh update` runs:

1. `git pull origin main` — pulls the latest code
2. Re-syncs `DOMAIN` and all derived vars in `.env.prod` (no manual editing needed)
3. Auto-generates any missing secrets (e.g. new keys added in this release)
4. `docker compose up -d --build --remove-orphans` — rebuilds images, restarts services
5. `db-migrate` container runs Drizzle ORM migrations automatically on startup

> **Never** run `docker compose down -v` — the `-v` flag deletes all volumes and data.

---

### Rollback

If a bad update breaks something:

```bash
# 1. Find the previous good commit
git log --oneline -10

# 2. Check out that commit
git checkout <HASH>

# 3. Rebuild
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d --build --remove-orphans

# 4. If DB migration was destructive, restore from backup
gunzip -c backups/db_YYYYMMDD_HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

Return to tracking `main` once the issue is resolved upstream:

```bash
git checkout main
git pull
./startup.sh update
```

---

## Android APK

### Install a pre-built APK

Pre-built debug APKs are in [`releases/android/`](./releases/android/).

**Steps:**

1. Enable **Developer options** on your Android device:
   Settings → About phone → tap *Build number* seven times
2. Enable **USB debugging**: Settings → Developer options → USB debugging
3. Connect via USB and tap **Allow** on the fingerprint prompt on the phone
4. Install the newest APK with ADB:

```bash
adb install -r -d releases/android/onetothree-debug.apk
```

5. Open the app → enter your server URL (e.g. `https://yourdomain.com`) → register

---

### Build from source

**Prerequisites on the build machine:**

| Tool | Version |
|------|---------|
| Docker | Required; used for the Android builder image when no local SDK is configured |
| Java JDK | Optional for native host build; 17 or 21 |
| Android SDK | Optional for native host build; Build-Tools 34+ |
| `ANDROID_HOME` | Optional; when unset, Docker build is used |

**Steps:**

```bash
# 1. Configure your server URL in .env.prod (must already be set up)
#    NEXT_PUBLIC_API_URL=https://api.yourdomain.com

# 2. Build debug APK
./startup.sh build-apk

# 3. Or build a signed release APK (requires a keystore)
./startup.sh build-apk-release /path/to/release.keystore
# Set env vars before running:
#   export RELEASE_STORE_PASSWORD=...
#   export RELEASE_KEY_ALIAS=upload
#   export RELEASE_KEY_PASSWORD=...
```

On Windows, the shortest path is:

```powershell
.\apkbuild.ps1
.\apkbuild.ps1 -Release -KeystorePath C:\keys\onetothree.jks
```

The APK lands in `releases/android/` as `onetothree-debug.apk` / `onetothree-release.apk` plus an immutable `onetothree-<type>-YYYYMMDD-HHMM-<gitsha>.apk` and matching `.sha256` files.

**What the build script does:**

1. Reads `NEXT_PUBLIC_API_URL` and other env vars from `.env.prod`
2. Runs `next build` with `NEXT_EXPORT=1` — static export to `client/out/`
3. Runs `cap sync android` — copies web assets into the Capacitor Android project
4. Runs `./gradlew assembleDebug` (or `assembleRelease`) — produces the APK

---

### ADB install

Use Android platform-tools from any OS:

```bash
adb devices
adb install -r -d releases/android/onetothree-debug.apk
```

**Common errors:**

| Error | Fix |
|-------|-----|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.onetothree.app` then reinstall |
| `device unauthorized` | Unlock phone → tap "Allow" on USB debugging prompt |
| `device offline` | Unplug and reconnect the USB cable |
| ADB not found | Install [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) and add to PATH |

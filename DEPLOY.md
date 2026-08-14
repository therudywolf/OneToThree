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

### Enabling guest links (optional, off by default)

One-time guest links (call guests + temp chats — see
`docs/project/GUEST_MODE_CONCEPT.ru.md`) are an explicit opt-in:

1. Set `FEATURE_GUESTS=1` in the api service environment (guest call links also
   need working calls: `FEATURE_CALLS` on + LiveKit configured). Optionally set
   `FEATURE_OPEN_REGISTRATION=0` to close self-registration so guest links
   become the only door for strangers.
2. **Edge checklist** (if your reverse proxy / Anubis / CrowdSec config is
   path-aware): allow `/guest/*` (the public entry pages) and `/api/guest/*`
   (resolve/knock/poll/enter). Keeping Anubis proof-of-work in front of
   `/guest/*` is recommended — it is the only anonymous app surface.
   Consider a CrowdSec scenario for bursts of `POST /api/guest/knock` or
   `/api/guest/enter` from one IP.
3. Lifetime and capacity tunables (env, with defaults):

   | Env | Default | What it bounds |
   |-----|---------|----------------|
   | `GUEST_LINK_TTL_HOURS` | `24` | Life of an unredeemed link |
   | `GUEST_MEETING_SEATS` | `10` | Seats on a new meeting link, clamped to 1…50 (a temp-chat link is always 1) |
   | `GUEST_MAX_LINKS_PER_USER` | `20` | Live links one member may hold |
   | `GUEST_MAX_ACTIVE` | `50` | Concurrent guests server-wide |
   | `GUEST_CHAT_TTL_HOURS` | `12` | Hard lifetime of a temp-chat guest |
   | `GUEST_SESSION_TTL_HOURS` | `12` | Guest session cookie; never extends past the guest's hard expiry |
   | `GUEST_OFFLINE_GRACE_MIN` | `60` | Offline time before the sweeper purges a guest who closed the tab |
   | `GUEST_SWEEP_INTERVAL_MS` | `300000` | Sweeper period (expired guests, dead links) |

   A guest's LiveKit token is minted with the ordinary
   `LIVEKIT_TOKEN_TTL_SECONDS` (default 2 h, clamped to 5 min…4 h) — there is
   no guest-specific knob for it.

4. Rate limits. These are flood defence, not what protects a link — a token is
   32 random characters, seats are capped in Postgres and live guests by
   `GUEST_MAX_ACTIVE`. Budgets are sized **per meeting, not per person**: a
   whole office, flat or conference room is one address, and each joining guest
   spends one `resolve` plus one `knock`.

   | Route | Env | Default |
   |-------|-----|---------|
   | `POST /api/guest/resolve` (read-only) | `GUEST_RESOLVE_RATE_LIMIT_MAX` | `60` per `GUEST_PUBLIC_RATE_LIMIT_WINDOW` (`15 minutes`) |
   | `POST /api/guest/knock`, `POST /api/guest/enter` (create state) | `GUEST_PUBLIC_RATE_LIMIT_MAX` | `30` per the same window |
   | `GET /api/guest/knock/:id` + `/cancel` (polling) | `GUEST_POLL_RATE_LIMIT_MAX` | `45` per minute |
   | `POST /api/messages/send` from a temp-chat guest | `GUEST_MSG_PER_MINUTE` | `20` per minute (everyone else keeps a flat 30) |

   `GUEST_MSG_PER_MINUTE` is keyed on the guest's own user id, so one guest
   cannot spend another's budget. A non-numeric, non-integer or non-positive
   value is refused: the default is used instead and the API logs a warning on
   every guest send. Do not read that warning as noise — the value you set is
   *not* in effect. (It has to fail loudly rather than silently: the limiter
   compares `current > max`, so a `NaN` max is never exceeded and garbage in
   this variable would REMOVE the limit it was set to tighten.)

   On top of all of the above sits the app-wide limiter (100/min, keyed
   `user:<id>` for an authenticated caller and `ip:<addr>` otherwise), so a
   guest is bounded even on a route with no budget of its own. It is
   Redis-backed and fails **open** on a store error: a Redis outage removes
   throttling, it does not lock the instance out.

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

1. Runs `doctor` checks for git, Docker, env, compose config, and disk space
2. `git fetch --all --prune` + ff-only pull of the current branch
3. Re-syncs `DOMAIN` and all derived vars in `.env.prod`
4. Builds and runs `db-migrate` idempotently
5. Rebuilds/restarts only affected services, or all core services with `--full`
6. Runs health, API `/health`, CSP, and optional TURN TLS checks

Useful modes: `--full`, `--no-pull`, `--no-cache`, `--skip-smoke`, `--skip-turn-sync`.

> **Never** run `docker compose down -v` — the `-v` flag deletes all volumes and data.

---

### Surgical redeploy (rebuild only web/api)

When only application code changed, `scripts/deploy-prod.sh` rebuilds just those
images: it migrates first, exports the build stamp, and verifies afterwards that
both the API and the client bundle report the version you actually built.

```bash
setsid nohup bash scripts/deploy-prod.sh > /tmp/deploy.log 2>&1 < /dev/null &
```

Two rules the script now enforces, because breaking them took production down:

- **One deploy at a time.** It refuses to start while another deploy — its own
  or a bare `docker compose … up --build` — is in flight. Two runs reaching the
  container-swap phase together leave the API removed and not restarted.
  `FORCE=1` overrides, for when you know the other run is dead.
- **Never deploy with a bare `docker compose up --build`.** That skips the
  migrations and bakes `APP_VERSION=dev` into both halves, which silently kills
  the "new build, reload" banner (`version-check.ts` skips the comparison for
  `dev`) and leaves nobody able to tell which commit prod is running.

Run it detached, as above: if the SSH session drops mid-build, the compose it
started keeps running as an orphan, and the next attempt would race it.

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

### ADB install (Windows)

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

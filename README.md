# OneToThree

Self-hosted end-to-end encrypted messenger. The server stores only ciphertext — private keys never leave the browser.

**[Русская документация → README.ru.md](./README.ru.md)**

Additional project docs are organized in [docs/README.md](./docs/README.md).

---

## Table of Contents

- [Features](#features)
- [Stack](#stack)
- [Requirements](#requirements)
- [Quick Deploy (5 minutes)](#quick-deploy-5-minutes)
- [start.sh Commands](#startsh-commands)
- [First Run Walkthrough](#first-run-walkthrough)
- [Updating](#updating)
- [Backup & Restore](#backup--restore)
- [Android App](#android-app)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Security](#security)
- [License](#license)

---

## Features

- **E2EE messaging** — AES-GCM-256 per message, ECDH key exchange, keys stored in browser vault
- **Voice & video calls** — WebRTC with TURN relay, DTLS-SRTP, connection quality monitoring
- **File sharing** — encrypted media upload to MinIO/S3, client-side decryption
- **Groups** — encrypted group key distribution per member
- **Multi-device** — QR-based device linking, device revocation
- **2FA** — optional TOTP (RFC 6238)
- **PWA** — installable on mobile, push notifications via Web Push (VAPID)
- **Self-hosted** — single `./start.sh` command, automatic TLS via Let's Encrypt

---

## Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend | Fastify 5, Node.js |
| Database | PostgreSQL (Drizzle ORM) |
| Media storage | MinIO (S3-compatible) |
| Reverse proxy | Caddy 2 (automatic TLS via Let's Encrypt) |
| TURN server | coturn (WebRTC relay for NAT traversal) |
| SFU (optional) | LiveKit (server-side media routing for group calls) |
| Orchestration | Docker Compose |
| Cryptography | Web Crypto API — AES-GCM-256, ECDH P-256, ECDSA, Argon2id |
| Mobile | Capacitor (Android APK) |

---

## Requirements

| Resource | Minimum |
|----------|---------|
| OS | Linux (Ubuntu 22.04+ recommended) |
| CPU | 2 vCPU (4+ recommended) |
| RAM | 4 GB |
| Disk | 20 GB SSD |
| Docker | Docker Engine 24+ with Compose v2 |
| Domain | 1 domain with 4 DNS records (see below) |
| Ports | 80/tcp, 443/tcp, 3478/tcp+udp, 5349/tcp, 49152–65535/udp |

---

## Quick Deploy (5 minutes)

### 1. Clone the repository

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
```

### 2. Set up DNS

Create five A records pointing to your server IP:

| Record | Type | Value | Cloudflare proxy |
|--------|------|-------|------------------|
| `example.com` | A | `YOUR_SERVER_IP` | Orange cloud (proxied) OK |
| `api.example.com` | A | `YOUR_SERVER_IP` | Orange cloud (proxied) OK |
| `s3.example.com` | A | `YOUR_SERVER_IP` | Orange cloud (proxied) OK |
| `turn.example.com` | A | `YOUR_SERVER_IP` | **Gray cloud (DNS only) — REQUIRED** |
| `lk.example.com` | A | `YOUR_SERVER_IP` | **Gray cloud (DNS only) — REQUIRED** |

> **Important:** The `turn.*` and `lk.*` records **must not** be proxied. Cloudflare blocks UDP — TURN relay and LiveKit media will not work behind the proxy. All other records can be proxied.

### 3. Open firewall ports

```bash
# Web (Caddy — HTTP challenge + HTTPS)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# TURN / STUN relay (coturn — WebRTC NAT traversal)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp

# LiveKit SFU — media and ICE/TCP fallback (if using SFU for calls)
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
```

> **`lk.*`** DNS record must also be **Gray cloud (DNS only)** in Cloudflare — same reason as `turn.*`. UDP media ports cannot pass through Cloudflare's proxy.

### 4. Launch

```bash
chmod +x ./start.sh
./start.sh
```

On **first run**, the script automatically:
1. Generates all secrets — DB password, MinIO password, JWT secret, TURN password, VAPID keys, LiveKit keys
2. Asks for your domain, ACME email, server IP, and VAPID contact email
3. Displays all credentials **once** — save them immediately!
4. Stores secrets in `./secrets/` (chmod 700, never committed to git)
5. Writes `.env.prod` with all required values
6. Builds and starts all 7 containers
7. Waits for health checks to pass

TLS certificates are obtained automatically from Let's Encrypt. First run takes 2–5 minutes.

### 5. Save your credentials

The credentials are shown **only once** during the first run. Copy them to a secure password manager immediately. If you lose them, delete `./secrets/` and re-run `./start.sh` to regenerate (existing data will be inaccessible with new DB passwords).

### 6. Register and become admin

1. Open `https://your-domain.com` in a browser
2. Register a new account
3. Promote yourself to admin:

```bash
docker exec -it forestmessenger-db-1 psql -U forest -d forest \
  -c "UPDATE users SET role = 'admin' WHERE username = 'yourusername';"
```

4. Open `/admin` while logged in

---

## start.sh Commands

| Command | Description |
|---------|-------------|
| `./start.sh` | Start the stack (builds images if needed) |
| `./start.sh stop` | Stop all containers |
| `./start.sh restart` | Restart containers without rebuilding |
| `./start.sh logs` | Tail live logs from all services |
| `./start.sh status` | Show container status |
| `./start.sh update` | Pull latest code, rebuild images, restart (data preserved) |
| `./start.sh backup` | Dump database to `backups/db_TIMESTAMP.sql.gz` |
| `./start.sh build-apk` | Build Android debug APK (requires Java 17 + Android SDK) |
| `./start.sh build-apk-release <keystore>` | Build signed release APK |

---

## First Run Walkthrough

When you run `./start.sh` for the first time, here is what happens step by step:

1. **Dependency check** — verifies Docker, Docker Compose, openssl, and curl are installed
2. **Volume check** — reports whether existing data volumes are found (they won't exist on first run)
3. **Secret generation**:
   - Auto-generates: `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `JWT_SECRET`, `WEBHOOK_SECRET`, `TURN_PASSWORD`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - Prompts you for: domain, ACME email, TURN external IP, VAPID contact email
   - Generates VAPID key pair (via Docker — requires pulling `node:20-alpine`)
   - Writes all secrets to `./secrets/` as individual files (Docker secrets format)
   - Displays credentials in a bordered box — **save them now**
4. **Env file sync** — creates `.env.prod` with all required values
5. **Validation** — checks all required fields are populated
6. **TURN check** — warns if TURN and API share the same hostname (Cloudflare conflict)
7. **Build & start** — runs `docker compose up -d --build`
8. **Health check** — waits for PostgreSQL, MinIO, API, and Next.js to report healthy
9. **Status** — prints container status, site URL, and helpful commands

> For a detailed beginner guide including VPS setup and Docker installation, see [docs/guides/FIRST_START.md](./docs/guides/FIRST_START.md).

---

## Updating

```bash
./start.sh update
```

This command:
1. Pulls the latest code from git (`git pull origin main`)
2. Rebuilds Docker images
3. Restarts containers with `--remove-orphans`
4. Database migrations run automatically via the `db-migrate` container on startup

**Your data is safe.** Databases, media files, and TLS certificates live in Docker named volumes (`pgdata`, `minio_data`, `caddy_data`) and are never touched by image rebuilds.

> **Warning:** Never run `docker compose down -v` — the `-v` flag deletes all volumes and data.

For detailed update procedures, rollback instructions, and pre-update checklists, see [docs/guides/UPDATE.md](./docs/guides/UPDATE.md).

---

## Backup & Restore

### Create a backup

```bash
./start.sh backup
```

This creates a compressed PostgreSQL dump at `backups/db_YYYYMMDD_HHMMSS.sql.gz`.

#### Encrypted backups

Set the `BACKUP_PASSPHRASE` environment variable to enable AES-256-CBC encryption of backup archives:

```bash
export BACKUP_PASSPHRASE="your-strong-passphrase"
./start.sh backup
```

When set, the backup script pipes the archive through `openssl enc -aes-256-cbc -pbkdf2` producing a `.tar.gz.enc` file. To decrypt:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -in backups/backup-*.tar.gz.enc -out backup.tar.gz -pass pass:"your-strong-passphrase"
```

If `BACKUP_PASSPHRASE` is not set, a warning is printed and the backup is created unencrypted.

### Restore from backup

```bash
gunzip -c backups/db_20260101_120000.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

> **Note:** Media files are stored in the MinIO volume separately. A full backup strategy should also include the MinIO data volume. You can export it with:
> ```bash
> docker run --rm -v forestmessenger_minio_data:/data -v $(pwd)/backups:/backup \
>   alpine tar czf /backup/minio_YYYYMMDD.tar.gz -C /data .
> ```

---

## Android App

A native Android app is available as an APK (built with Capacitor).

### Install a pre-built APK

Pre-built debug APKs are in [`releases/android/`](./releases/android/).

1. Enable "Install from unknown sources" on your Android device.
2. Transfer and install the `.apk` file.
3. Set the server URL when prompted on first launch.

### Build from source

Prerequisites: Java 17+, Android SDK, `ANDROID_HOME` environment variable set.

```bash
./start.sh build-apk             # debug APK  (reads .env.prod for server URL)
./start.sh build-apk-release <keystore>  # signed release APK
```

The APK is placed at `releases/android/onetothree-debug.apk` (or `onetothree-release.apk`).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Caddy fails to get TLS certificate | Confirm DNS A records resolve to this server. Ensure ports 80 and 443 are open. Check logs: `./start.sh logs` and look for Caddy errors. |
| WebRTC calls don't connect | Ensure `turn.*` DNS is set to **DNS only** (gray cloud) in Cloudflare. Verify `TURN_EXTERNAL_IP` matches your server's public IP (`curl -s ifconfig.me`). Check that ports 3478 and 49152–65535/udp are open. |
| Login redirect loop on `/login` | Verify `COOKIE_DOMAIN` is set to `.your-domain.com` (with leading dot) in `.env.prod`. Rebuild the API container after changes. |
| `relation "users" does not exist` | Database migration failed. Check: `docker compose -f docker-compose.prod.yml logs db-migrate` |
| Media shows "File expired" | The object was purged by the retention policy, or the peer needs to re-send the file. |
| Wrong client IPs in logs | Set `TRUST_PROXY=1` in `.env.prod` so Fastify reads the `X-Forwarded-For` header from Caddy. |
| Containers keep restarting | Check resource limits. The stack needs at least 4 GB RAM. Run `./start.sh logs` to find the failing service. |
| `./start.sh` says secrets not initialized | Delete `./secrets/` and re-run `./start.sh` to regenerate all secrets. |

---

## Architecture

The stack consists of 7 Docker containers:

```
                    ┌─────────┐
                    │  Caddy   │ :80, :443
                    │ (reverse │ automatic TLS
                    │  proxy)  │
                    └────┬─────┘
           ┌─────────────┼─────────────┐
           │             │             │
      ┌────▼───┐   ┌────▼───┐   ┌────▼───┐
      │ Next.js│   │ Fastify│   │  MinIO  │
      │  :3000 │   │  :8080 │   │  :9000  │
      └────────┘   └───┬────┘   └─────────┘
                       │
                  ┌────▼────┐
                  │ Postgres│
                  │  :5432  │
                  └─────────┘

      ┌──────────┐
      │  coturn   │ :3478 (host network)
      │ TURN/STUN │ :49152–65535/udp
      └──────────┘
```

- **Caddy** — reverse proxy, automatic HTTPS certificates from Let's Encrypt
- **Next.js** — frontend PWA (SSR, static assets, service worker)
- **Fastify** — API server, WebSocket relay, push notification dispatch
- **PostgreSQL** — user accounts, chat metadata, encrypted message storage
- **MinIO** — S3-compatible object storage for encrypted media
- **db-migrate** — one-shot container that runs Drizzle ORM migrations on startup
- **coturn** — TURN/STUN server for WebRTC NAT traversal (host networking for UDP)

For full architecture details, see [docs/project/ARCHITECTURE.md](./docs/project/ARCHITECTURE.md).

---

## Security

OneToThree uses a **zero-trust server model**:

- **Private keys never leave the browser.** The key vault is encrypted locally with Argon2id (t=3, m=64 MiB) + AES-GCM-256; legacy vaults are auto-upgraded on unlock.
- **Server stores only ciphertext.** Messages, media, and group keys are opaque encrypted blobs.
- **Authentication via ECDSA challenge-response.** No passwords are ever sent to the server.
- **Media is encrypted before upload** to MinIO with per-file unique keys.
- **WebRTC signaling is relayed as opaque payloads** — the server does not parse SDP.
- **Infrastructure secrets use Docker secrets** — credentials are mounted at `/run/secrets/*`, not stored as plaintext environment variables.

For the full threat model, cryptographic details, and security audit findings, see [SECURITY.md](./SECURITY.md).

---

## License

OneToThree is licensed under the **GNU Affero General Public License v3.0** (AGPLv3).
- ✅ Free to use, modify, and self-host
- ✅ You can fork and create your own version
- ⚠️ If you run a modified version as a network service, you **must** publish your source code under AGPLv3
- ⚠️ Derivative works must also be AGPLv3

See [LICENSE](./LICENSE) for full terms.

# Forest Messenger

Self-hosted end-to-end encrypted messenger. The server stores only ciphertext — private keys never leave the browser.

**[Русская документация → README.ru.md](./README.ru.md)**

---

## Features

- **E2EE messaging** — AES-GCM-256 per message, ECDH key exchange, keys stored in browser vault
- **Voice & video calls** — WebRTC with TURN relay, ICE fallback, connection quality monitoring
- **File sharing** — encrypted media upload to MinIO/S3, client-side decryption
- **Groups** — encrypted group key distribution per member
- **Multi-device** — QR-based device linking, device revocation
- **2FA** — optional TOTP (RFC 6238)
- **PWA** — installable, offline banner, push notifications via Web Push (VAPID)
- **Self-hosted** — single Docker Compose stack, automatic TLS via Let's Encrypt (Caddy)

**Stack:** Next.js 16 · Fastify · PostgreSQL · MinIO · WebRTC · Caddy · coturn

---

## Quick Start

### Requirements

- Linux VPS (4+ vCPU, 4+ GB RAM recommended)
- Docker + Docker Compose v2
- Domain with DNS pointing to the server
- Ports **80**, **443**, **3478/tcp+udp**, **49152–65535/udp** open

### 1. Clone and configure

```bash
git clone -b ver2 https://github.com/therudywolf/OneToThree.git
cd OneToThree
cp .env.prod.example .env.prod
nano .env.prod
```

Fill in the **6 required fields** (marked `← FILL IN` in the file):

| Variable | What to set |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password for the database |
| `MINIO_ROOT_PASSWORD` | Strong random password for file storage |
| `CORS_ORIGIN` | Your domain: `https://your-domain.com` |
| `ACME_EMAIL` | Your email for Let's Encrypt notifications |
| `TURN_EXTERNAL_IP` | Server public IP: `curl -s ifconfig.me` |
| `TURN_PASSWORD` | Strong random password for TURN relay |

Everything else (`JWT_SECRET`, `WEBHOOK_SECRET`, VAPID keys) is **auto-generated** on first run.

### 2. Configure DNS

Point DNS records to your server IP:

| Record | Type | Value |
|---|---|---|
| `your-domain.com` | A | Server IP |
| `api.your-domain.com` | A | Server IP |
| `s3.your-domain.com` | A | Server IP |
| `turn.your-domain.com` | A | Server IP ← **DNS only, no proxy** |

> **Cloudflare users:** `turn.*` must be set to **"DNS only" (gray cloud)**. The orange proxy blocks UDP traffic that WebRTC calls need. The other records can stay proxied.

### 3. Open firewall ports

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:65535/udp
```

### 4. Launch

```bash
chmod +x ./start.sh
./start.sh
```

The script will:
1. Auto-generate missing secrets (`JWT_SECRET`, `WEBHOOK_SECRET`, VAPID keys)
2. Sync `TURN_PASSWORD` to `NEXT_PUBLIC_TURN_PASSWORD` automatically
3. Build and start all containers
4. Wait for health checks to pass
5. Show the stack status

TLS certificates are obtained automatically from Let's Encrypt. First run takes 2–5 minutes.

---

## Managing the Stack

```bash
./start.sh              # Start / rebuild
./start.sh stop         # Stop all containers
./start.sh restart      # Restart without rebuilding
./start.sh logs         # Live logs (all services)
./start.sh status       # Container status
./start.sh update       # git pull + rebuild (data preserved)
./start.sh backup       # Dump database → backups/db_TIMESTAMP.sql.gz
```

### Update to a new version

```bash
./start.sh update
```

This runs `git pull` and rebuilds images. **Databases, files, and TLS certificates are preserved** — they live in Docker named volumes and are never touched by `--build`.

> Never run `docker compose down -v` unless you want to erase all data.

---

## First Admin

After the stack is running, register through the normal signup flow, then promote yourself to admin:

```bash
./start.sh status   # confirm stack is healthy first

docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  psql -U forest -d forest \
  -c "UPDATE users SET role = 'admin' WHERE username = 'your_handle';"
```

Then open `/admin` while logged in.

---

## Backup & Restore

**Create a backup:**
```bash
./start.sh backup
# Saves to: backups/db_YYYYMMDD_HHMMSS.sql.gz
```

**Restore from backup:**
```bash
gunzip -c backups/db_20260101_120000.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

---

## Caddyfile (Custom Domains)

Edit `Caddyfile` to replace `onetothree.ru` with your domain, then rebuild:

```bash
./start.sh restart
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Caddy fails to get certificate | Confirm DNS resolves to this server, ports 80/443 are open. Check: `./start.sh logs` → filter caddy |
| WebRTC calls don't work | Make sure `turn.*` DNS is **not** proxied by Cloudflare. Check `TURN_EXTERNAL_IP` is correct |
| Login redirect loop `/login` | Set `COOKIE_DOMAIN=.your-domain.com` in `.env.prod`, rebuild api |
| `relation "users" does not exist` | Migration failed — check: `docker compose logs db-migrate` |
| Media shows "File expired" | Object was purged by retention policy or peer must re-send |
| Wrong IPs in logs | Ensure `TRUST_PROXY=1` in `.env.prod` |

---

## Security Model

- **Private keys never leave the browser.** The vault is encrypted with PBKDF2 + AES-GCM locally.
- **Server stores only ciphertext.** Messages, media, and group keys are opaque blobs.
- **Auth via ECDSA challenge-response.** No passwords sent to the server.
- **Media encrypted before upload** to MinIO.
- **WebRTC signaling is relayed as opaque payloads** — server does not parse SDP.

See [SECURITY.md](./SECURITY.md) for the full threat model and [ARCHITECTURE.md](./ARCHITECTURE.md) for data flow details.

---

## Environment Reference

Full reference: [`.env.prod.example`](./.env.prod.example)

| Variable | Auto-generated | Required |
|---|---|---|
| `POSTGRES_PASSWORD` | No | Yes |
| `MINIO_ROOT_PASSWORD` | No | Yes |
| `CORS_ORIGIN` | No | Yes |
| `ACME_EMAIL` | No | Yes |
| `TURN_EXTERNAL_IP` | No | Yes |
| `TURN_PASSWORD` | No | Yes |
| `JWT_SECRET` | Yes | — |
| `WEBHOOK_SECRET` | Yes | — |
| `VAPID_PUBLIC_KEY` | Yes | — |
| `VAPID_PRIVATE_KEY` | Yes | — |
| `DATABASE_URL` | Yes (from POSTGRES_*) | — |

---

## Contact

[Telegram](https://t.me/rudy_wolf) · [GitHub](https://github.com/therudywolf)

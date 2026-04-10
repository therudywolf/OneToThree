# PROJECT 13 / FOREST MESSENGER

**One to Three** — a clinical, **E2EE-fortified shadow bunker** for your pack.  
Self-hosted. Zero-trust lane. The server routes blind; the client encrypts.

```
┌─────────────────────────────────────────────────────────────┐
│  :: NO CLOUD CHAT ::  :: NO PLAINTEXT AT REST ::  :: PWA    │
│  POSTGRES · MINIO · FASTIFY · NEXT · WEBRTC · CADDY         │
└─────────────────────────────────────────────────────────────┘
```

[![Stack](https://img.shields.io/badge/Stack-Monolith-000000?style=flat-square&logo=docker&logoColor=00FFFF)](https://github.com/therudywolf)
[![E2EE](https://img.shields.io/badge/E2EE-AES--GCM%2BECDH-FF0000?style=flat-square)](./SECURITY.md)

> *The corridor is lit only by cyan spill. Every packet is a sealed envelope.*

---

## Identity

| Field | Value |
|--------|--------|
| **Codename** | Project 13 (Forest Messenger / One to Three) |
| **Posture** | Host-level control · browser-held keys · opaque ciphertext on disk |
| **Operator** | [Rudy Wolf](https://rudywolf.ru) |

---

## Stack (frozen manifest)

| Layer | Technology |
|--------|------------|
| **Web** | **Next.js 16** (App Router), React 19, Tailwind (purged: `src/app`, `components`, `hooks`, `lib`) |
| **API** | **Fastify** + `@fastify/websocket` + **web-push** (VAPID) |
| **Data** | **PostgreSQL** + **Drizzle ORM** |
| **Objects** | **MinIO** (S3-compatible presigned PUT/GET) |
| **Realtime** | **WebRTC** (STUN + custom WS signaling) |
| **Edge** | **Caddy 2** (TLS termination, reverse proxy) |

Deep references: **[API.md](./API.md)** · **[ARCHITECTURE.md](./ARCHITECTURE.md)** · **[SECURITY.md](./SECURITY.md)**

---

## Security architecture (short wire)

1. **Vault (browser)** — Passphrase-derived wrapping; **ECDSA P-256** for auth challenges; **ECDH** for session message keys. Server stores **public** signing JWK + opaque `vault_blob` only.
2. **Messaging** — **AES-GCM-256** payloads; direct chats derive from ECDH; group keys are wrapped per member ciphertext.
3. **TOTP 2FA** — Optional RFC 6238; server stores encrypted secret flag; no SMS dependency.
4. **Warden (admin)** — Role-gated `/admin` + `/api/admin/*`; **host-level** moderation (reports, visibility). Does **not** decrypt E2EE message bodies.
5. **Transport** — `fm_session` HTTP-only cookie; **CORS** locked to explicit origins in production; **`TRUST_PROXY=1`** behind Caddy so **`request.ip`** reflects the real client.

Global **`setErrorHandler`**: production responses for **5xx** are **`{ "error": "INTERNAL_SERVER_ERROR" }`** — no stack traces to clients.

---

## The Monolith launch (production)

### Prerequisites

- **Docker** + **Compose v2** (`docker compose`) on the host (Linux VPS, or **WSL2** / macOS for `./setup.sh`).
- **TLS PEMs**: `./certs/cert.pem` and `./certs/key.pem` (mounted read-only into Caddy — see `Caddyfile`).
- **`.env.prod`** at repo root (copy from **`env.prod.example`** and replace every secret).

### Single claw

```bash
chmod +x ./setup.sh
./setup.sh
```

The script:

1. Verifies `docker` and Compose are available.  
2. Warns if `./certs/cert.pem` is missing.  
3. Validates **non-empty** `POSTGRES_PASSWORD`, `JWT_SECRET`, `MINIO_ROOT_PASSWORD`, and `CORS_ORIGIN` inside `.env.prod`.  
4. Runs **`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`**.  
5. **`db-migrate`** runs automatically as a **one-shot** after Postgres is **healthy**; **api** waits for migrate + MinIO + DB.

### `docker-compose.prod.yml` (hardened)

- **`restart: always`** on `db`, `minio`, `api`, `web`, `caddy`.  
- **Healthchecks**: Postgres (`pg_isready`), MinIO (`mc ready`), API (`GET /health`), Web (Node `fetch` to `:3000/`).  
- **Caddy** starts only when **web**, **api**, and **minio** are healthy.  
- **Resource caps** (small VPS–friendly defaults): `api` **384m / 0.75 CPU**, `web` **768m / 1.25 CPU** (tune in Compose).  
- **`TRUST_PROXY`** passed into API (default **`1`** in Compose when unset).

### DNS → Caddy

Point **A/AAAA** records for your apex, **api.** subdomain, and **s3.** (or your MinIO hostname) at the VPS. Align hostnames in **`Caddyfile`** with `env.prod.example` / `.env.prod` (`NEXT_PUBLIC_API_URL`, `CORS_ORIGIN`).

---

## Warden bootstrap (first admin)

After the stack is healthy and you have registered the first user (normal signup flow), promote them **inside the DB** (example — adjust container/user names):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  psql -U forest -d forest -c "UPDATE users SET role = 'admin' WHERE username = 'your_handle';"
```

Then open **`/admin`** while logged in as that user. Rotate secrets if this command ever appears in shell history on a shared box.

---

## Digital Den (local media cache)

| Concern | Behaviour |
|---------|-----------|
| **Client** | **Dexie** / IndexedDB **`project13-media-cache`** stores **decrypted** media blobs keyed by `message_id` (device-only; fastest replay). |
| **Cap** | **~1 GiB** total + **200 entries** max — oldest evicted first so the first **1000+ text messages** do not bloat media storage. |
| **Server** | **Retention purge** (optional): deletes MinIO objects older than **`MEDIA_RETENTION_DAYS`** (default **30**) and nulls `media_path` on rows. **Off-peak** mode in production: purge runs only between **01:00–06:00 UTC** unless `MEDIA_PURGE_OFF_PEAK=0`. Small batches + **25 ms** delay between row updates to reduce lock pressure. |
| **Download policy** | Presigned GET only if a **live** `messages.media_path` row still claims the object — otherwise **`410 FILE_EXPIRED`**. UI: *FILE EXPIRED ON SERVER* / *Срок хранения на сервере истек.* |

**Settings → SENSORS → DIGITAL DEN:** shows occupancy and **CLEAR LOCAL CACHE**. Nuclear “purge local” in Settings also wipes this store.

---

## Developer quick lane (not production)

```bash
npm install
npm run setup          # merges .env templates, JWT/VAPID hints
docker compose up --build   # dev stack: Next dev + API on :3000 / :8080
```

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev (client) |
| `npm run dev:server` | Fastify with reload |
| `npm run build` | Production **client + server** |
| `npm run db:push` | Drizzle schema → Postgres (local) |

---

## i18n

- **EN / RU** — login + in-app globe; Settings includes language.  
- Keys live in **`client/src/locales/en.ts`** and **`ru.ts`** — keep them in sync when adding UI.

---

## Repository hygiene

- **Never commit** `.env`, `.env.prod`, `.env.local`, or live TLS keys.  
- **Tracked:** `server/drizzle/*.sql` migrations.  
- **Ignored:** `backups/`, `logs/`, volume dirs — see `.gitignore`.

---

## Backup

```bash
npx tsx scripts/backup.ts
```

---

## Troubleshooting (field notes)

| Symptom | Likely fix |
|---------|------------|
| Caddy TLS fails | Install **`./certs/cert.pem`** + **`key.pem`**; reload stack. |
| `FILE_EXPIRED` on media | Object purged or row cleared — peer must re-send; local **Digital Den** may still have a copy. |
| Wrong client IP in logs | Set **`TRUST_PROXY=1`** for API behind Caddy. |
| `relation "users" does not exist` | Ensure **`db-migrate`** completed; `docker compose … logs db-migrate`. |

---

## Contact

[Telegram](https://t.me/rudy_wolf) · [X](https://x.com/therudywolf) · [GitHub](https://github.com/therudywolf)

---

*Project 13 / Forest Messenger — the monolith stands; the vault stays on your machine.*

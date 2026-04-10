# PROJECT 13 (One to Three)

**Secure self-hosted PWA messenger** · by [Rudy Wolf](https://rudywolf.ru)

![Terminal UI](https://img.shields.io/badge/UI-Cyberpunk_Terminal-000000?style=flat-square&logo=react&logoColor=00FFFF)
![Zero Trust](https://img.shields.io/badge/Security-Zero_Trust-FF0000?style=flat-square&logo=lock&logoColor=white)
![Self-Hosted](https://img.shields.io/badge/Deploy-Self_Hosted-4B32C3?style=flat-square&logo=docker&logoColor=white)

> *Numb but alive. Awoo~*
>
> Если ты это читаешь, значит, тебе нужен зашифрованный канал для своей стаи, где сервер слеп, как крот, а UI не выжигает глаза. Добро пожаловать в тринадцатый сектор.

---

## Vision

**Project 13 (One to Three)** is a **self-hosted, zero-trust, end-to-end encrypted** progressive web app for messaging. The backend is a deliberate “dumb router”: it authenticates sessions, stores ciphertext and opaque blobs, and moves signaling — it never sees plaintext. No Supabase, no third-party chat cloud: **Postgres**, **MinIO**, **Fastify**, **your keys**.

## Features

| Layer | What you get |
|--------|----------------|
| **E2E text & media** | AES-GCM payloads; keys derived via **ECDH** (direct) or wrapped group keys (group chats). |
| **Calls** | **Native WebRTC** — offers/answers/ICE over a **custom WebSocket** (no PeerJS). |
| **Push** | **Web Push (VAPID)** implemented in **Fastify**; generic notification copy for privacy. |
| **Storage** | **MinIO** (S3 API) — client encrypts blobs, uploads via **presigned URLs**. |
| **Auth** | **ECDSA challenge–response** — no passwords on the server; only public keys and signatures. |

## Stack

- **Client:** Next.js 14 (App Router), Tailwind, PWA (Workbox / next-pwa).
- **Server:** Node.js, **Fastify**, `@fastify/websocket`, `web-push`.
- **DB:** PostgreSQL + **Drizzle ORM**.
- **Object storage:** MinIO.
- **Crypto (browser):** Web Crypto — **AES-GCM-256**, **ECDH**, **ECDSA**.

## Quick start

**Requirements:** Node.js **≥ 18**, **Docker** with Compose v2 (for the full stack).

### 1. Clone and install the monorepo

```bash
git clone https://github.com/therudywolf/project-13.git
cd project-13
npm install
```

Root `npm install` installs workspace dependencies and **Drizzle Kit** at the repo root (used by `db:*` scripts). The API Docker image uses its own **`server/package-lock.json`** so `npm ci` works inside the `server/` build context.

### 2. Environment templates (recommended)

```bash
npm run setup
```

`npm run setup` merges keys into existing `server/.env` and `client/.env.local` (from `*.example`), generates **JWT** secrets, a **VAPID** key pair, and (if needed) strong **MinIO** credentials, and syncs Compose-related vars into the **root** `.env` when present. Edit `DATABASE_URL` if your Postgres URL differs from the default.

**Why run this before Docker?** The **web** container mounts `./client` and reads **`client/.env.local`** for `NEXT_PUBLIC_*` (including VAPID). Without `setup`, you may see missing VAPID warnings until those files exist.

### 3. Start everything with one command

```bash
docker compose up --build
# same as:
npm run docker:up
# same as:
npm run prod:start
```

This builds and starts, in order:

| Step | Service | What it does |
|------|---------|----------------|
| 1 | **db** | PostgreSQL (`forest` / `forest`), port **5432** |
| 2 | **minio** | S3-compatible storage, **9000** (API), **9001** (console) |
| 3 | **db-migrate** | One-shot **`drizzle-kit push`** against Postgres inside the network (`db:5432`) — no manual `npm run db:push` needed for Docker |
| 4 | **api** | Production Fastify image, port **8080** (waits for DB + MinIO + successful migrate) |
| 5 | **web** | Next.js **dev** server in Docker, port **3000** (`npm install` then `next dev`, with bind-mount to `./client`) |

**db** and **minio** start in parallel; **api** waits for both to be healthy **and** for **db-migrate** to exit successfully.

**URLs:**

- **Web UI:** [http://localhost:3000](http://localhost:3000)  
- **API:** [http://localhost:8080](http://localhost:8080)  
- **MinIO console:** [http://localhost:9001](http://localhost:9001) (default user/password from Compose or your `.env`)

For PWA install, push subscriptions, and media uploads from the browser, use **HTTPS** on a real domain in production (or a tunnel); localhost is fine for development.

### Database schema outside Docker

- **`npm run db:push`** — push schema using root `drizzle.config.ts` and your local `DATABASE_URL` (from root `.env` via `dotenv`).
- **`npm run db:push:docker`** — same, but loads **`docker.db.env`** (Postgres on **localhost:5432** when the `db` container publishes the port).

After you change **`server/src/db/schema.ts`** and use Compose, re-apply inside the stack without a full rebuild:

```bash
docker compose run --rm db-migrate
```

### Workspace commands

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev (client workspace) |
| `npm run dev:server` | Fastify API with hot reload |
| `npm run build` | Production build — client + server |
| `npm run docker:up` | `docker compose up --build` — full stack |
| `npm run prod:start` | Same as `docker:up` |
| `npm run docker:down` | Stop Compose stack |
| `npm run db:generate` | Drizzle: generate SQL from schema |
| `npm run db:push` | Drizzle: push schema (local / root env) |
| `npm run db:push:docker` | Drizzle: push via `docker.db.env` (host → containerized Postgres) |
| `npm run db:studio` | Drizzle Studio |

### Reset Postgres data and browser vault (fresh start)

To wipe **server-side** accounts and start clean:

```bash
docker compose down -v
```

`-v` removes named volumes (Postgres, MinIO, anonymous Next volumes). Then bring the stack up again (`docker compose up --build`).

Also clear **browser** storage for `http://localhost:3000` (DevTools → Application → **Clear site data** / IndexedDB), or old **vault** keys and cookies will still be on the device while the server DB is empty — login can fail with confusing errors.

**Auth note:** `PUBLIC_KEY_CONFLICT` means this **handle** already exists on the server with a **different ECDSA key** than your local vault (e.g. you re-registered after only clearing one side). Use **Login** with the original vault, pick another handle, or reset **both** DB and local site data as above.

### What belongs in Git

- **Tracked:** `server/drizzle/*.sql` — **schema migration** files (not live data).
- **Ignored:** `backups/`, `*.dump`, `postgres_data/`, `.env` — see `.gitignore`. Do not commit live database dumps or volume directories.

### Language (EN / RU)

- **Login:** globe button in the **top-right** toggles `en` / `ru`.
- **In-app:** same globe in the header after login; **`[ CFG ]`** → Settings also has a language selector.

### Next.js dev badge (corner)

The client runs **`next dev --webpack`** (see `client/package.json`). The small **Next.js** indicator in the corner during development is turned off with **`devIndicators: false`** in `client/next.config.js` — it is not a separate “Turbopack mode” toggle for this project.

### Same-origin API (session cookie + middleware)

The browser must call **`/api/*` on the same host as the Next app** (e.g. `http://localhost:3000/api/...`) so the **`fm_session`** cookie is scoped to **:3000**. `next.config.js` **rewrites** `/api/:path*` to Fastify (`API_INTERNAL_URL` in Docker: `http://api:8080`; locally defaults to `http://127.0.0.1:8080`). **`NEXT_PUBLIC_API_URL` should be empty** (or unset) in `client/.env.local` for this mode.

WebSockets still connect **directly** to Fastify on **port 8080** (see `NEXT_PUBLIC_WS_ORIGIN` if you need to override).

## Security model (short)

1. **Authentication:** The server issues a short-lived challenge; the client signs it with an **ECDSA P-256** private key held in the user vault. The server stores only the **public** JWK.
2. **E2E messaging:** **ECDH** (NIST curves) derives shared AES keys for direct chats; **group** keys are wrapped per member and stored as opaque blobs. The server sees ciphertext and IVs only.
3. **Media:** Files are **encrypted in the browser** before upload; MinIO holds ciphertext. Metadata in the DB references paths and IVs, not plaintext.
4. **Calls:** WebRTC peer connections are established via **custom signaling** over the WebSocket. The server relays opaque `offer`/`answer`/`ICE` blobs — it cannot intercept media streams.
5. **Search:** Message search is **client-side only**, operating over the already-decrypted message array in browser memory. No plaintext ever reaches the server.

## Conceptual zero-knowledge map

```
┌─────────────────────────────────────────────────┐
│                  CLIENT (Browser)               │
│  ┌─────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ ECDSA   │  │ ECDH     │  │ AES-GCM-256    │ │
│  │ Sign    │  │ Derive   │  │ Encrypt/Decrypt │ │
│  └────┬────┘  └────┬─────┘  └───────┬────────┘ │
│       │            │                │           │
│  [challenge]  [shared key]    [ciphertext+IV]   │
│       │            │                │           │
└───────┼────────────┼────────────────┼───────────┘
        │            ×                │
        ▼            │                ▼
┌───────────────────────────────────────────────┐
│               SERVER (Blind Router)           │
│  Stores: public JWK, ciphertext, IVs, paths  │
│  Sees:   nothing in plaintext                 │
│  Routes: WS signals, push notifications       │
└───────────────────────────────────────────────┘
```

## API reference

See **[API.md](./API.md)** for complete endpoint and WebSocket protocol documentation.

## Deep-dive docs

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — monorepo structure, auth flow, WS + media routing.
- **[SECURITY.md](./SECURITY.md)** — cryptographic primitives, threat model, and operational controls.

## i18n policy

- **Conversational Layer (Translate):** Тексты гидов, человекочитаемые ошибки, подсказки, настройки. Всё, что общается с пользователем (человеком).
- **System/Noir Layer (Hardcoded EN):** Терминальные маркеры (`[ OPEN ]`, `[ REBOOT_SESSION ]`, `:: NETWORK_OFFLINE`), крипто-статусы, консольные логи. Всё, что имитирует работу железа или терминала.

## Repository hygiene

- **Never commit** `.env`, `.env.local`, or `.env.production` with real secrets. Templates live in `*.example` files only.
- If `.env` was ever committed, rotate all secrets and consider **`git filter-repo`** or BFG to purge history — a normal `.gitignore` commit does not remove past blobs.

### After cloning (maintainers)

If you use the workflow “re-index ignore rules”:

```bash
git rm -r --cached .
git add .
git commit -m "chore: project 13 branding and security purge"
```

Review `git status` before pushing.

## Drizzle note

`server/drizzle/meta/` is listed in `.gitignore` (local Drizzle cache). **SQL migrations** under `server/drizzle/*.sql` are the source of truth when you use the migration workflow; regenerate with `npm run db:generate` after editing `server/src/db/schema.ts`.

**Docker:** the **`db-migrate`** service runs **`drizzle-kit push`** once **`db`** is healthy and before **`api`** starts. After you change **`server/src/db/schema.ts`**, re-apply with `docker compose run --rm db-migrate` or `docker compose up --build` (rebuilds the migrate image when the Dockerfile or copied files change).

## Reverse proxy (production)

A ready-made **nginx** template lives at `deploy/nginx.conf`. Key points:

- Enables **WebSocket** upgrade for `/api/` (required for real-time chat and WebRTC signaling).
- Sets `client_max_body_size 64m` for encrypted media uploads.
- Adds HSTS, `X-Frame-Options`, `X-Content-Type-Options` headers.
- Replace `your-domain.example.com` and the SSL certificate paths with your own.

For **Caddy**, the equivalent is a simple reverse-proxy block since Caddy handles TLS automatically.

## Backup

```bash
npx tsx scripts/backup.ts
```

Dumps the Postgres database and MinIO data from running Docker containers into a timestamped `.tar.gz` archive under `backups/`.

## API access file log (optional)

Set **`API_FILE_LOG=1`** on the **api** service (and optionally **`API_LOG_DIR`**). The server appends one line per response to **`logs/api-access-<YYYY-MM-DDTHH>utc.log`** (UTC hour rotation). The `logs/` directory is gitignored.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` warning during `docker compose up` | Run `npm run setup` first. The key is read from `client/.env.local`, not from Docker Compose env. |
| `relation "users" does not exist` | With Compose, **`db-migrate`** should run before **api**. Check logs for `db-migrate` errors; then `docker compose run --rm db-migrate` or `npm run db:push:docker` (host → Postgres on **localhost:5432**). For a non-Docker Postgres, use `npm run db:push`. |
| `npm ci` fails in Docker for **api** | Ensure **`server/package-lock.json`** is present and committed (Docker build context is `./server`). |
| Login fails with **PUBLIC_KEY_CONFLICT** / odd auth after DB reset | Clear **browser** site data for localhost (vault still has old keys) or use **Login** with the vault that matches the server; see **Reset Postgres data and browser vault** above. |
| Logged in but **stay on `/login`** or bounce back | Session cookie must be on **:3000**: use **empty** `NEXT_PUBLIC_API_URL` and **Next rewrites** (see **Same-origin API**). Old setups pointed the client at `:8080` — that breaks `src/proxy.ts` middleware. Re-run **`npm run setup`** or clear `NEXT_PUBLIC_API_URL` in `client/.env.local`. |
| Small **Next** icon in the corner (dev) | Disabled via `devIndicators: false` in `client/next.config.js`; rebuild/restart `web` if you still see it. |
| CORS errors on media upload | MinIO does not support `PutBucketCors`; the API silently ignores this. If using a proxy, ensure `Access-Control-Allow-Origin` headers pass through. |
| `PutBucketCors … NotImplemented` in API logs | Harmless — MinIO limitation. The warning is silently suppressed. |
| PWA / Push not working | Web Push requires HTTPS. Use a tunnel (e.g. `ngrok`, `cloudflared`) for local testing. Ensure VAPID keys match between client and server. |
| iOS Safari 100vh issues | The UI uses `100dvh` (dynamic viewport height). If the browser doesn't support it, a CSS fallback is provided. |
| WebSocket drops behind reverse proxy | Ensure your proxy passes `Upgrade` and `Connection` headers. See `deploy/nginx.conf`. |

## Contact

[Telegram](https://t.me/rudy_wolf) · [X](https://x.com/therudywolf) · [GitHub](https://github.com/therudywolf)

---

*Project 13 · One to Three — the server routes; the client encrypts.*

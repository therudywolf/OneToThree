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

**Requirements:** Node.js **≥ 18**, Docker (for the full stack).

```bash
git clone https://github.com/therudywolf/project-13.git
cd project-13
npm install
npm run setup
```

`npm run setup` copies `server/.env.example` → `server/.env` and `client/.env.local.example` → `client/.env.local`, then generates **JWT** and **webhook** secrets, a **VAPID** key pair, and (if needed) strong **MinIO** credentials. Edit `DATABASE_URL` if your Postgres URL differs.

Bring up the full stack (Postgres, MinIO, schema push, API, Next.js dev) in one step:

```bash
docker compose up --build
```

(`npm run docker:up` runs the same command.) The **`db-migrate`** service applies the Drizzle schema before the API starts, so you do not need a separate `npm run db:push` for Docker.

For **local** development without Docker (or to refresh the DB after changing `server/src/db/schema.ts` against a running Postgres), use `npm run db:push` as before. After editing the schema and using Compose, you can re-apply with:

```bash
docker compose run --rm db-migrate
```

- **Web UI:** [http://localhost:3000](http://localhost:3000)  
- **API:** [http://localhost:8080](http://localhost:8080)

For PWA install, push subscriptions, and media uploads from the browser, use **HTTPS** on a real domain in production (or tunnel); localhost is fine for development.

### Workspace commands

| Script | Purpose |
|--------|---------|
| `npm run dev` | Next.js dev (client workspace) |
| `npm run dev:server` | Fastify API with hot reload |
| `npm run build` | Production build — client + server |
| `npm run docker:down` | Stop Compose stack |

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

`server/drizzle/meta/` is listed in `.gitignore` (local Drizzle cache). **SQL migrations** under `server/drizzle/*.sql` remain the source of truth for schema changes; regenerate with `npm run db:generate` when the schema changes.

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

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` warning during `docker compose up` | Run `npm run setup` first. The key is read from `client/.env.local`, not from Docker Compose env. |
| `relation "users" does not exist` | Apply the DB schema: `npm run db:push:docker` (for Dockerized Postgres) or `npm run db:push` (local). |
| CORS errors on media upload | MinIO does not support `PutBucketCors`; the API silently ignores this. If using a proxy, ensure `Access-Control-Allow-Origin` headers pass through. |
| `PutBucketCors … NotImplemented` in API logs | Harmless — MinIO limitation. The warning is silently suppressed. |
| PWA / Push not working | Web Push requires HTTPS. Use a tunnel (e.g. `ngrok`, `cloudflared`) for local testing. Ensure VAPID keys match between client and server. |
| iOS Safari 100vh issues | The UI uses `100dvh` (dynamic viewport height). If the browser doesn't support it, a CSS fallback is provided. |
| WebSocket drops behind reverse proxy | Ensure your proxy passes `Upgrade` and `Connection` headers. See `deploy/nginx.conf`. |

## Contact

[Telegram](https://t.me/rudy_wolf) · [X](https://x.com/therudywolf) · [GitHub](https://github.com/therudywolf)

---

*Project 13 · One to Three — the server routes; the client encrypts.*

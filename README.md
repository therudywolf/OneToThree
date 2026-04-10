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

Bring up infrastructure:

```bash
npm run docker:up
```

Apply the database schema:

```bash
npm run db:push
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

## Contact

[Telegram](https://t.me/rudy_wolf) · [X](https://x.com/therudywolf) · [GitHub](https://github.com/therudywolf)

---

*Project 13 · One to Three — the server routes; the client encrypts.*

# Manifest of the Pack — Project 13 (One to Three)

Production-oriented file map and launch verification. For stack details see [README.md](./README.md).

---

## Core tree (critical paths)

```text
ForestMessenger/
├── setup.sh                    # Production “single claw” launcher
├── docker-compose.prod.yml     # Hardened Compose (db, minio, api, web, caddy, db-migrate)
├── docker-compose.yml          # Dev-oriented compose (optional local lane)
├── Caddyfile                   # TLS + reverse proxy to web / api / MinIO hostnames
├── env.prod.example            # Template → copy to `.env.prod` (secrets)
├── .env.prod.example           # Same contract as env.prod.example (docs / CI)
├── MANIFEST.md                 # This file
├── certs/                      # Host-mounted PEMs (not committed)
│   ├── cert.pem                # TLS certificate
│   └── key.pem                 # Private key
├── server/
│   ├── Dockerfile
│   └── src/
│       ├── index.ts            # Entry
│       ├── app.ts              # Fastify app wiring
│       ├── db/                 # Drizzle schema & DB access
│       ├── routes/             # HTTP routes (auth, chats, messages, ws, admin, …)
│       └── lib/                # error-handler, s3, session, crypto helpers, …
└── client/
    ├── Dockerfile
    └── src/
        ├── app/                # Next.js App Router (layouts, pages)
        ├── hooks/              # Data & UI hooks
        └── lib/                # API client, crypto, caches (IndexedDB), …
```

---

## Silence protocol (client, production)

- **React Query Devtools:** not used in this repo; nothing to strip from the bundle.
- **`next.config.js`:** `compiler.removeConsole` in production (removes `log` / `debug` / `info` from the bundle; keeps `warn` / `error`).
- **`SilenceConsole`:** mounted from `client/src/app/layout.tsx` — runtime no-op for `console.log` / `debug` / `info` in production.
- **Error boundary:** generic localized copy only (`errors.boundaryGeneric` / `errors.retrySession`); no stack traces or raw `Error.message` in the UI.
- **Fastify `setErrorHandler`:** full error logged server-side; clients receive **`{ "error": "INTERNAL_SERVER_ERROR" }`** for **5xx** in production (see `server/src/lib/error-handler.ts`).

---

## Step-by-step launch verification (dry run)

Use this as a mental checklist; fix blockers before pointing users at the host.

### 1. Environment

| Step | Risk |
|------|------|
| DNS **A/AAAA** for apex, `api.`, MinIO host point to VPS | Propagation delay → TLS/CORS mismatch until records settle |
| **`./setup.sh`** creates **`.env.prod`** from **`.env.prod.example`** when missing; otherwise fill secrets manually | Weak placeholders for Postgres/MinIO still rejected |
| Align `CORS_ORIGIN`, `NEXT_PUBLIC_*` URLs with real HTTPS hostnames | Browser blocks cookies or API calls |

### 2. Orchestration (`setup.sh` → Compose)

| Step | Risk |
|------|------|
| `docker` + Compose v2 available | Script exits if `docker compose` missing |
| **`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`** | Build failures, port conflicts on host (only Caddy should bind 80/443) |
| **`app_network`** (implicit from compose) | Name clashes rare; custom networks OK |
| Volumes **`pgdata`**, **`minio_data`**, **`caddy_data`** | Wrong permissions or full disk → DB/MinIO/Caddy unhealthy |

### 3. Bootstrap

| Step | Risk |
|------|------|
| **`db-migrate`** one-shot after Postgres healthy | Migration failure → API may not start or may error at runtime |
| MinIO ready + bucket/policy init (see compose/API) | API storage routes fail if MinIO not reachable |

### 4. Security

| Step | Risk |
|------|------|
| **`./certs/cert.pem`** + **`./certs/key.pem`** present and valid for hostnames | Caddy TLS handshake fails; script warns if cert missing |
| **TOTP** enabled per user in app | Operator must store backup codes; seed flow is in-app (no secrets in logs) |

### 5. Connectivity

| Step | Risk |
|------|------|
| Caddy → **web** (Next) and **api** (Fastify) upstreams | Mis-typed `Caddyfile` host blocks → 502 |
| **WebSocket** upgrade through Caddy to API signaling | Proxy must pass `Upgrade` / `Connection`; timeouts too low → dropped signaling |
| **WebRTC** (STUN + signaling) | Firewall/NAT symmetric issues are outside the repo; STUN must be reachable |

---

## Single Claw file verification (Cursor-checked)

| Artifact | Role |
|----------|------|
| `setup.sh` | Automator — Compose up with env + cert warnings |
| `docker-compose.prod.yml` | Orchestrator — services, volumes, health |
| `Caddyfile` | Shield — TLS + reverse proxy |
| `env.prod.example` / `.env.prod.example` | Template — copy to `.env.prod` |
| `client/Dockerfile` | Web blueprint |
| `server/Dockerfile` | API blueprint |

---

## Alpha checklist (RU) — после деплоя

1. **DNS:** `onetothree.ru`, `api.onetothree.ru`, `s3.onetothree.ru` → **A** на **5.187.0.150** (проверить с внешней машины).
2. **Сертификаты:** `certs/cert.pem` и `certs/key.pem` на сервере в каталоге репозитория.
3. **Окружение:** из шаблона (`.env.prod.example` или `env.prod.example`) → **`.env.prod`**, заполнить JWT, пароли БД/MinIO, `CORS_ORIGIN`, `NEXT_PUBLIC_*`.
4. **Запуск:** `chmod +x setup.sh && ./setup.sh`.
5. **Warden:** первый админ — по README (SQL в контейнере БД).
6. **Silence check:** в браузере нет «отладочных» панелей и технических кодов в UI при сбоях — только суровый Noir (`SIGNAL LOST` / `ERROR`). Технические детали — **`docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api`**.

---

## External / ignored

- **`certs/`** — PEMs supplied by the operator; never commit real keys.

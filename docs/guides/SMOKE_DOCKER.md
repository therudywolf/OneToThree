# Smoke checks (Docker / staging)

Use after `./startup.sh update` or an equivalent `docker compose` stack with `api`, `web`, `db`, `redis`, `minio`.

## Build verification

- **Web (TypeScript + Next):** `docker build -f client/Dockerfile client` with build args from [`docker-compose.prod.yml`](../../docker-compose.prod.yml) (or minimal `NEXT_PUBLIC_*` placeholders). Expect `Finished TypeScript` and exit code 0.
- **Favorites API:** With Postgres available and `DATABASE_URL` set, from `server/`: `npm ci && npm test -- src/routes/chats-favorites.test.ts` (integration test creates user + chat, POST/DELETE favorite, GET list).

## Manual UI (logged-in)

1. **Favorites:** Open sidebar → star a chat → it should move to the top section immediately; reload page → star state persists. Unstar → order updates; server remains source of truth after refetch.
2. **Direct (DM):** In sidebar, under “New conversation” / peer field, enter exact `@username` or peer UUID → **Message** → new `direct_e2e` chat opens. Errors: unknown user, self-chat blocked — should surface translated messages.
3. **QR device link:** On account A: Settings → link device → show QR. On device B (logged out or login screen): scan → should obtain session or 2FA prompt per server rules. Token is single-use; link expires per `QR_LINK_TTL` in API.

## When something fails

- Capture browser Network tab for `/api/chats`, `/api/chats/:id/favorite`, `/api/auth/qr-login`.
- For migrations: `db-migrate` container logs should show journal SQL count matching `server/drizzle`.

# OneToThree "Lite" — one-click personal server (exploratory plan)

_Status: FAR-OFF plan, branch `plan/selfhost-lite`. Not scheduled, not on main.
Goal: capture the design so it's ready to pick up. Nothing here is implemented._

## Goal

A **personal** OneToThree server anyone can stand up on **Linux / Windows / macOS**
with essentially **one click** — double-click a launcher (or run one command),
get a working private E2EE messenger for you + a handful of friends/family. Trade
the full prod stack's scale/ops for radical simplicity. Keep the thing that
matters — **end-to-end encryption** — intact.

Non-goal: replace the full self-hosted deployment (`docker-compose.prod.yml` +
Caddy + Anubis + LiveKit + coturn), which stays the path for real multi-user
hosting. Lite is the "just me and my people" tier.

## What the full stack needs today (the weight to shed)

| Component | Prod | Why it's heavy for "personal" |
|---|---|---|
| Postgres | required | separate service to run/backup |
| Redis | **optional already** (in-memory fallback exists) | can drop for single-process |
| MinIO (S3) | required for media | separate service |
| Caddy | TLS + single-origin routing | separate service |
| LiveKit SFU | group calls | heavy; needs its own server + keys |
| coturn | call relay | separate service |
| Anubis WAF | edge protection | irrelevant for a private box |

The server **already tolerates no-Redis** (test-setup drops `REDIS_URL` → in-memory
fallbacks), which is the key enabler: single-process is viable.

## Feature scope for Lite

IN (keep):
- 1:1 chat + small group/SECTOR chats (full E2EE, unchanged crypto).
- Saved Messages, replies, reactions, edits, polls, attachments.
- **1:1 calls** — already E2EE peer-to-peer (ECDH); needs only STUN (use a public
  STUN or none on LAN). No SFU.
- Device linking (the `deposit_secret` rendezvous flow), recovery phrase.
- Media rotation/local-cache (already built) with local-filesystem storage.

OUT / degraded (for now):
- **Group calls** (LiveKit SFU) — omit, or fall back to the existing mesh/relay
  path capped at a tiny N. Group calling is the single biggest thing Lite drops.
- Push notifications (VAPID/FCM) — optional; works only when configured.
- WAF / rate-limit tuning / multi-replica WS fan-out.
- coturn (self-hosted TURN) — rely on direct/LAN or a public STUN.

## Architecture options (ranked)

### Option A — "compose-lite" (fastest to build, needs Docker)
One `docker-compose.lite.yml` with a reduced service set: `db` (Postgres) + `api`
(NODE serving REST **and** the static client on one port) + local **bind-mount
media dir** instead of MinIO, no Redis, no Caddy, no LiveKit/coturn/Anubis.
- One-click = a per-OS launcher that runs `docker compose -f docker-compose.lite.yml up -d`
  and opens the browser: `start.command` (mac), `start.bat` (win), `start.desktop`/`.sh` (linux).
- Pros: minimal code change; reuses existing images; Postgres stays (no schema port).
- Cons: **requires Docker Desktop** installed → not truly "one click" for
  non-technical users.
- Work: a media adapter (S3 API → local FS, or run MinIO single-binary in the
  compose as the one extra service); serve client from Fastify static; a lite env.

### Option B — single self-contained binary (the real "one click", most work)
Bundle everything into one executable per OS (Node SEA or `pkg`): built Fastify
server + embedded static client + **embedded Postgres (PGlite)** + **local-FS
media** + in-memory Redis fallback. Double-click → server + browser open. No
Docker, no separate services.
- Pros: genuine one-click, no prerequisites, easy to distribute (one file).
- Cons: biggest lift —
  - **DB:** move off the external Postgres to **PGlite** (embedded Postgres in
    Node). The drizzle schema is pg-dialect, so PGlite (real Postgres) fits far
    better than SQLite (which would need a schema rewrite: `pgEnum`, `uuid`
    defaults, `bigserial`, advisory locks used in polls, etc.). Verify PGlite
    supports what we use (advisory locks, `gen_random_uuid`, JSON, arrays).
  - **Media:** an S3-compatible shim over the local filesystem, or refactor the
    `lib/s3` seam to a `MediaStore` interface with an `fs` implementation
    (presign → signed local URLs served by the same process).
  - **Packaging:** Node SEA per-OS + native deps (argon2 is pure-JS already; check
    `@node-rs`/sharp/etc. for native bits).
- Work: significant; do it behind interfaces so the full stack is unaffected.

### Option C — desktop app that hosts (Tauri/Electron wrapper)
Ship the Lite server *inside* the existing Tauri desktop app: the app runs the
bundled server locally and is both host and first client. Others connect over
the network to that machine.
- Pros: reuses the Tauri build; "install the app, you're a server" story.
- Cons: host must keep the app running; still needs the Option-B server internals
  (embedded DB + local media). Effectively Option B + a Tauri host shell.

**Recommendation:** ship **Option A first** (compose-lite) as a quick, usable
milestone for Docker-capable users, then invest in **Option B** (PGlite + local-FS
single binary) as the true one-click. Option C is a nice packaging on top of B.

## The hard refactors that unlock B (and are worth doing behind interfaces)

1. **`MediaStore` seam.** Today `lib/s3.ts` is imported directly by `storage.ts`
   (createS3Client/presign/ensureBucket/deleteObject). Extract an interface with
   two impls: `S3MediaStore` (prod) and `FsMediaStore` (lite — writes under a data
   dir, "presigns" to a token URL the same process serves). The storage test we
   just added already mocks this seam, so it's test-friendly.
2. **DB provider seam.** `db/index.ts` builds a postgres.js client. Add a PGlite
   path selected by env (`DB_DRIVER=pglite`), sharing the same drizzle schema +
   the file-based migrations (PGlite can run the same SQL). Validate advisory
   locks (poll vote fix) + `gen_random_uuid` + arrays under PGlite.
3. **Single-origin serving.** Serve the exported client (`client/out` or `next
   start`) from the API process so there's one port and the SameSite=Lax cookie +
   WS work without Caddy (the e2e harness already proves single-origin works).
4. **Calls config.** `CALL_MEDIA_MODE=lite`: 1:1 P2P only, STUN-only ICE, group
   calls disabled in the UI with a clear "not available on Lite" note.

## Networking / reachability (personal box)

- **Default:** `http://localhost:<port>` for the host; LAN IP for same-network
  devices.
- **Remote access, one-click-friendly:** integrate an outbound tunnel so no port
  forwarding / TLS setup is needed — e.g. **Tailscale** (private mesh, ideal for
  "me + family") or **cloudflared** quick tunnel. Document both; default to
  Tailscale for privacy. TLS: Lite can run plain HTTP on localhost/LAN, or rely on
  the tunnel's TLS for remote.
- Cookie/CORS: reuse the native-app origin handling; add the tunnel origin to CORS.

## Security posture (must NOT regress)

- **E2EE unchanged** — same vault, Double Ratchet, SECTOR, fan-out. Lite changes
  transport/storage, never the crypto.
- Keep `assertProdSecurityEnv` semantics adapted for lite (localhost is fine
  without CORS_ORIGIN=*, but never ship `RATE_LIMIT_DISABLED`/dev bypasses).
- Media at rest is already E2EE (encrypted blobs); local-FS store holds ciphertext.
- Single-user/admin bootstrap: first account = creator (existing group logic).

## Rough phasing

- **M0 (spike):** `docker-compose.lite.yml` (db + api serving client + MinIO
  single service or FS bind) + per-OS launcher scripts + `.env.lite`. Usable for
  Docker users. (~days)
- **M1:** `MediaStore` + DB provider seams landed behind env flags on main
  (no behaviour change for prod), covered by tests. (~1–2 wks)
- **M2:** PGlite + FsMediaStore + single-origin serving → Docker-free run via
  `node .` / `npm run lite`. (~1–2 wks)
- **M3:** Node SEA single-binary packaging per OS + signed launchers; optional
  Tailscale/cloudflared integration; group-calls-disabled UX. (~1–2 wks)
- **M4 (optional):** fold the Lite server into the Tauri app (Option C).

## Open questions to resolve before building
- PGlite feature coverage (advisory locks, extensions, concurrency) — spike first.
- Native module surface for SEA packaging (audit `server` + `client` deps).
- Do we want group calls on Lite at all, or is 1:1 acceptable for the tier?
- Update channel for the single binary (auto-update vs manual re-download).

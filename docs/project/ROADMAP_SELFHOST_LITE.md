# 🗺 Roadmap — OneToThree **Lite** (one-click self-host)

> _English first, [Русская версия ниже](#-дорожная-карта--onetothree-lite)._

**Goal:** a **Lite** edition anyone can stand up in one click on Linux / macOS /
Windows, with a simplified feature set chosen via **checkboxes** (calls on/off,
media on/off, stickers/GIF on/off, …). The full edition (current `main`) stays
as-is; Lite is a configuration + packaging layer on top, not a fork of the app
logic.

Work happens on branch **`plan/selfhost-lite`**; each sprint merges to `main`
behind feature flags so nothing breaks the full build.

---

## What Lite includes vs. makes optional

Defaults below are what the **installer** ships (`scripts/lite/install.mjs`);
every one is a checkbox except where noted. Env flag = `FEATURE_*`.

| Capability | Installer default | Toggle | Why optional |
| --- | --- | --- | --- |
| E2EE 1:1 + group **text** (DR-v2/X3DH) | ✅ always | — | the core product |
| Auth, device-link, phrase recovery | ✅ always | — | core |
| **Media** (photo/voice/video/file) | ✅ on | `FEATURE_MEDIA` (checkbox) | needs object storage (MinIO) + disk |
| **Calls** (voice/video) | ⬜ off | `FEATURE_CALLS` (checkbox) | needs coturn + an external LiveKit + open UDP ports (heaviest infra) |
| **Stickers** (import/create) | ✅ on | `FEATURE_STICKERS` (checkbox) | needs object storage; Telegram import needs a bot token |
| **GIF** (Tenor/Giphy) | ✅ on | `FEATURE_GIF` (checkbox) | third-party requests / API keys |
| **Push** (Web Push/VAPID) | ⬜ off | `FEATURE_PUSH` (checkbox) | VAPID keys; not needed for a personal server |
| **2FA** (TOTP) | ✅ on | `FEATURE_2FA` (checkbox) | cheap, keep on |
| **Guest links** (meetings / temp chats) | ⬜ off | `FEATURE_GUESTS` (checkbox) | the only unauthenticated surface — explicit opt-in; guest calls also need LiveKit |
| **Admin panel** | ✅ on | `FEATURE_ADMIN` (env only) | single-user servers may hide it |
| **Groups/channels** | ✅ on | `FEATURE_GROUPS` (env only) | core-ish; not a wizard checkbox |
| Object storage (MinIO) | on with media/stickers | derived (`media` compose profile) | — |
| coturn + LiveKit | external, only if calls on | not bundled (you provide `OT_LIVEKIT_*`) | — |

**Minimum baseline** (uncheck everything optional) = encrypted text messaging,
one Postgres + Redis + api + web + caddy, one domain, no MinIO/coturn/LiveKit.
The installer's *default* preset turns media/stickers/GIF on (so MinIO is
included); calls/push are off. Each checkbox adds the infra it needs.

---

## Sprints

### Sprint 0 — Feature-flag foundation
- [x] Server: `FEATURE_*` flags + `GET /capabilities` (root **and** `/api/capabilities`) reporting the enabled set (`feature-flags.ts`; all default ON).
- [x] Client: `CapabilitiesProvider` fetches `/api/capabilities` once (fail-open to all-ON) and hides disabled surfaces — call button, media attach + record, GIF/sticker tabs, sticker/push/2FA settings, admin link. No dead buttons. Covered by unit + DOM tests.
- [x] Desktop build reads host + CSP from env (`build:selfhost`, shipped in 0.9.3) — extend the same env-driven flags to the Android (Capacitor) build.
- [x] Server: `FEATURE_*` flags also **gate the route groups** — a disabled feature's route group isn't registered (→ 404 for calls/gif/push/stickers/admin), the shared storage module 403s its chat-media endpoints (avatars stay open), and the WS layer rejects call/WebRTC signaling. Covered by `feature-gating.test.ts`; full suite green.
- **Exit:** ✅ full build unchanged with all flags on; turning a flag off removes both the UI surface **and** the API surface end-to-end.

### Sprint 1 — Lite compose profiles ✅ (2026-07-03)
- [x] `docker-compose.lite.yml`: db + redis + api + web + caddy; MinIO pulled in by the `media` profile. Calls are **not** bundled — the API points at an external LiveKit via `OT_LIVEKIT_*` (a bundled `calls` profile is Sprint 3).
- [x] Single-origin (web + `/api` + `/api/ws` behind one Caddy, the e2e WS-cookie pattern) → **one** hostname, not five. `local` (HTTP, `COOKIE_SECURE=0`) and `domain` (auto-HTTPS, production) modes.
- [ ] Embedded/simplified Postgres (or evaluate a SQLite adapter). _(deferred — uses a small Postgres container for now.)_
- **Exit:** `docker compose --env-file .env.lite -f docker-compose.lite.yml up` → working server on one origin. ✅

### Sprint 2 — One-click installer (checkboxes) ✅ (2026-07-03)
- [x] Cross-platform interactive installer `scripts/lite/install.mjs` (Node, no deps): mode + host/domain, **checkbox feature toggles**, generates secrets + `.env.lite` + `infra/lite/Caddyfile`, selects the compose profiles, launches.
- [x] `scripts/lite/install.sh` / `install.ps1` wrappers; root `npm run lite`. Guide: [docs/guides/LITE.md](../guides/LITE.md).
- **Exit:** a newcomer runs `npm run lite`, ticks "calls: off, media: on", and has a server. ✅

### Sprint 3 — Optional infra without external deps
- [ ] Local-filesystem media driver behind the same storage interface, so `FEATURE_MEDIA` can be on **without** running MinIO on tiny servers.
- [ ] **Bundled LiveKit + coturn `calls` profile** so `FEATURE_CALLS` works one-click. Today Lite calls point the API at an **external** LiveKit you run (`OT_LIVEKIT_*`); this brings a self-contained SFU (with UDP port publishing + generated keys) into the compose behind a `calls` profile.
- **Exit:** media works on a 1-container Lite install; calls work without hand-rolling a LiveKit.

### Sprint 4 — Native apps for Lite + packaging
- [ ] Extend `build:selfhost` to Android (Capacitor): same `OT_*` env → APK pointed at the user's Lite server, features trimmed to their flags.
- [ ] Prebuilt "Lite" Docker image + published one-liner; Lite quickstart docs (EN/RU).
- **Exit:** "here's your server + your app," end to end.

### Sprint 5 — GUI installer & polish
- [x] Graphical installer with real checkboxes — a **first-run web wizard** (`npm run lite:gui`, zero-dep Node HTTP server bound to `127.0.0.1`, launchers `scripts/lite/lite-gui.{sh,ps1}` for macOS/Windows). Shares `scripts/lite/lite-core.mjs` with the Sprint-2 CLI, so both emit identical `.env.lite` + Caddyfile. Also fills the old VAPID gap: enabling Push now generates a real keypair (`generateVapidKeys`, Node crypto only).
- [x] Post-install health dashboard — the wizard streams `docker compose up` build logs (SSE) and then polls `/api/status` (container states + `/health`), showing the "promote yourself to owner" step.
- [ ] Upgrade path from Lite → full.

---
---

# 🗺 Дорожная карта — OneToThree **Lite**

**Цель:** редакция **Lite**, которую любой поднимает в один клик на Linux / macOS
/ Windows, с упрощённым набором функций, выбираемым **галочками** (звонки
вкл/выкл, медиа вкл/выкл, стикеры/GIF вкл/выкл…). Полная версия (текущий `main`)
остаётся как есть; Lite — слой конфигурации и упаковки поверх, а не форк логики.

Спринты 0–2 **выпущены в v0.10.0** (влиты в `main` за фиче-флагами — все по
умолчанию ВКЛ, полная сборка не меняется). Спринты 3–5 — впереди.

## Что в Lite всегда, а что опционально

Значения по умолчанию ниже — то, что ставит **установщик** (`scripts/lite/install.mjs`);
каждое, кроме отмеченного, — галочка. Env-флаг = `FEATURE_*`.

| Возможность | По умолчанию | Переключатель | Почему опционально |
| --- | --- | --- | --- |
| E2EE-**текст** 1:1 и группы (DR-v2/X3DH) | ✅ всегда | — | ядро продукта |
| Авторизация, привязка устройств, восстановление | ✅ всегда | — | ядро |
| **Медиа** (фото/голос/видео/файлы) | ✅ вкл | `FEATURE_MEDIA` (галочка) | нужен object storage (MinIO) + диск |
| **Звонки** | ⬜ выкл | `FEATURE_CALLS` (галочка) | нужны coturn + внешний LiveKit + открытые UDP-порты |
| **Стикеры** | ✅ вкл | `FEATURE_STICKERS` (галочка) | нужен storage; импорт из TG — bot token |
| **GIF** (Tenor/Giphy) | ✅ вкл | `FEATURE_GIF` (галочка) | сторонние запросы / API-ключи |
| **Push** (VAPID) | ⬜ выкл | `FEATURE_PUSH` (галочка) | не нужен на личном сервере |
| **2FA** (TOTP) | ✅ вкл | `FEATURE_2FA` (галочка) | дёшево, оставляем |
| **Гостевые ссылки** (встречи / временные чаты) | ⬜ выкл | `FEATURE_GUESTS` (галочка) | единственная неаутентифицированная поверхность — только явным согласием; гостевым звонкам нужен ещё LiveKit |
| **Админка** | ✅ вкл | `FEATURE_ADMIN` (только env) | на одиночном сервере можно скрыть |
| **Группы/каналы** | ✅ вкл | `FEATURE_GROUPS` (только env) | почти ядро; не галочка мастера |
| MinIO | вкл при медиа/стикерах | производное (профиль `media`) | — |
| coturn + LiveKit | внешний, только при звонках | не встроен (свой `OT_LIVEKIT_*`) | — |

**Минимальная база** (снять все опции) = зашифрованный текст, один Postgres + Redis
+ api + web + caddy, один домен, без MinIO/coturn/LiveKit. **Дефолтный** пресет
установщика включает медиа/стикеры/GIF (значит, поднимается MinIO); звонки/push
выкл. Каждая галочка добавляет нужную ей инфраструктуру.

## Спринты

- **✅ Спринт 0 — Фундамент фиче-флагов.** Серверные `FEATURE_*` гейтят группы
  роутов (выключенная фича 404/403) + `GET /capabilities` (корень и `/api`); клиент
  прячет выключенные UI (кнопка звонка, вложения, вкладки стикеров/GIF, настройки).
  Env-флаги для десктопа есть (`build:selfhost`, 0.9.3) — на Android ещё нет.
- **✅ Спринт 1 — Lite-профили compose.** `docker-compose.lite.yml` (db+redis+api+
  web+caddy); MinIO — только по профилю `media`. Звонки не встроены: API смотрит на
  **внешний** LiveKit через `OT_LIVEKIT_*` (встроенный — Спринт 3). Один домен
  (single-origin) → **одна** DNS-запись вместо пяти.
- **✅ Спринт 2 — Установщик в один клик (галочки).** Кросс-платформенный
  интерактивный установщик (`scripts/lite/install.mjs`, Win/Mac/Linux): режим local/
  domain + **галочки**, генерит секреты + `.env.lite` + Caddyfile, выбирает профиль,
  запускает. `install.sh`/`install.ps1`, `npm run lite`.
- **Спринт 3 — Медиа в Lite без MinIO + встроенный LiveKit.** Драйвер медиа на
  локальной ФС (`FEATURE_MEDIA` без MinIO на маленьких серверах) + профиль `calls`
  со встроенным LiveKit+coturn, чтобы звонки работали из коробки.
- **Спринт 4 — Нативные приложения под Lite + упаковка.** `build:selfhost` для
  Android; готовый Lite-образ + one-liner; квикстарт (EN/RU).
- **Спринт 5 — GUI-установщик и полировка.** Графический установщик с настоящими
  галочками (мини Tauri-приложение или веб-мастер первого запуска), дашборд
  здоровья, апгрейд Lite → full.

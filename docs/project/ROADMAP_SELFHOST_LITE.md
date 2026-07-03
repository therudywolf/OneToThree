# 🗺 Roadmap — OneToThree **Lite** (one-click self-host)

> _English first, [Русская версия ниже](#-дорожная-карта--onetothree-lite)._
> General production roadmap: [ROADMAP.md](./ROADMAP.md).

**Goal:** a **Lite** edition anyone can stand up in one click on Linux / macOS /
Windows, with a simplified feature set chosen via **checkboxes** (calls on/off,
media on/off, stickers/GIF on/off, …). The full edition (current `main`) stays
as-is; Lite is a configuration + packaging layer on top, not a fork of the app
logic.

Work happens on branch **`plan/selfhost-lite`**; each sprint merges to `main`
behind feature flags so nothing breaks the full build.

---

## What Lite includes vs. makes optional

| Capability | Lite default | Toggle | Why optional |
| --- | --- | --- | --- |
| E2EE 1:1 + group **text** (DR-v2/X3DH) | ✅ always | — | the core product |
| Auth, device-link, phrase recovery | ✅ always | — | core |
| **Media** (photo/voice/video/file) | ⬜ off | `FEATURE_MEDIA` | needs object storage (MinIO) + disk |
| **Calls** (voice/video) | ⬜ off | `FEATURE_CALLS` | needs coturn + LiveKit + open UDP ports (heaviest infra) |
| **Stickers** (import/create) | ⬜ off | `FEATURE_STICKERS` | needs object storage; Telegram import needs a bot token |
| **GIF** (Tenor/Giphy) | ⬜ off | `FEATURE_GIF` | third-party requests / API keys |
| **Push** (Web Push/VAPID) | ⬜ off | `FEATURE_PUSH` | VAPID keys; not needed for a personal server |
| **2FA** (TOTP) | ✅ on | `FEATURE_2FA` | cheap, keep on |
| **Admin panel** | ✅ on | `FEATURE_ADMIN` | single-user servers may hide it |
| Object storage (MinIO) | only if media/stickers on | derived | — |
| coturn + LiveKit | only if calls on | derived | — |

**Lite baseline = encrypted text messaging, near-single-container stack, one
domain, embedded/simple Postgres, no MinIO/coturn/LiveKit.** Each checkbox adds
the infra it needs.

---

## Sprints

### Sprint 0 — Feature-flag foundation
- [ ] Server: `FEATURE_*` env flags gate the route groups (media/calls/stickers/gif/push); add `GET /capabilities` returning the enabled set.
- [ ] Client: fetch `/capabilities` once, hide disabled UI (call button, attach, sticker/GIF tabs) — no dead buttons.
- [x] Desktop build reads host + CSP from env (`build:selfhost`, shipped in 0.9.3) — extend the same env-driven flags to the Android (Capacitor) build.
- **Exit:** full build unchanged with all flags on; turning a flag off cleanly removes the surface end-to-end.

### Sprint 1 — Lite compose profiles
- [ ] `docker-compose.lite.yml`: minimal services (db + api + web + caddy); MinIO/coturn/LiveKit pulled in only by a compose **profile** when their flag is on.
- [ ] Single-origin mode (one domain, `/api` + `/api/ws` behind one Caddy — the e2e harness already proves the WS-cookie path works) so Lite needs **one** DNS record, not five.
- [ ] Embedded/simplified Postgres (or evaluate a SQLite adapter).
- **Exit:** `docker compose -f docker-compose.lite.yml up` → working encrypted-text server on one domain.

### Sprint 2 — One-click installer (checkboxes)
- [ ] Cross-platform interactive installer (Node CLI first — runs on Win/Mac/Linux): prompts domain + **checkbox toggles**, generates `.env` + secrets, picks the compose profile, launches.
- [ ] `install.sh` / `install.ps1` one-liners that fetch + run it.
- **Exit:** a newcomer runs one command, ticks "calls: off, media: on", and has a server.

### Sprint 3 — Lite media without MinIO (optional infra)
- [ ] Local-filesystem media driver behind the same storage interface, so `FEATURE_MEDIA` can be on **without** running MinIO on tiny servers.
- **Exit:** media works on a 1-container Lite install.

### Sprint 4 — Native apps for Lite + packaging
- [ ] Extend `build:selfhost` to Android (Capacitor): same `OT_*` env → APK pointed at the user's Lite server, features trimmed to their flags.
- [ ] Prebuilt "Lite" Docker image + published one-liner; Lite quickstart docs (EN/RU).
- **Exit:** "here's your server + your app," end to end.

### Sprint 5 — GUI installer & polish
- [ ] Graphical installer with real checkboxes (small Tauri app or a first-run web wizard) wrapping the Sprint-2 CLI.
- [ ] Post-install health dashboard; upgrade path from Lite → full.

---
---

# 🗺 Дорожная карта — OneToThree **Lite**

**Цель:** редакция **Lite**, которую любой поднимает в один клик на Linux / macOS
/ Windows, с упрощённым набором функций, выбираемым **галочками** (звонки
вкл/выкл, медиа вкл/выкл, стикеры/GIF вкл/выкл…). Полная версия (текущий `main`)
остаётся как есть; Lite — слой конфигурации и упаковки поверх, а не форк логики.

Работа — в ветке **`plan/selfhost-lite`**; каждый спринт вливается в `main` за
фиче-флагами, чтобы не ломать полную сборку.

## Что в Lite всегда, а что опционально

| Возможность | По умолчанию в Lite | Флаг | Почему опционально |
| --- | --- | --- | --- |
| E2EE-**текст** 1:1 и группы (DR-v2/X3DH) | ✅ всегда | — | ядро продукта |
| Авторизация, привязка устройств, восстановление | ✅ всегда | — | ядро |
| **Медиа** (фото/голос/видео/файлы) | ⬜ выкл | `FEATURE_MEDIA` | нужен object storage (MinIO) + диск |
| **Звонки** | ⬜ выкл | `FEATURE_CALLS` | нужны coturn + LiveKit + открытые UDP-порты |
| **Стикеры** | ⬜ выкл | `FEATURE_STICKERS` | нужен storage; импорт из TG — bot token |
| **GIF** (Tenor/Giphy) | ⬜ выкл | `FEATURE_GIF` | сторонние запросы / API-ключи |
| **Push** (VAPID) | ⬜ выкл | `FEATURE_PUSH` | не нужен на личном сервере |
| **2FA** (TOTP) | ✅ вкл | `FEATURE_2FA` | дёшево, оставляем |
| **Админка** | ✅ вкл | `FEATURE_ADMIN` | на одиночном сервере можно скрыть |
| MinIO | только если медиа/стикеры | производное | — |
| coturn + LiveKit | только если звонки | производное | — |

**База Lite = зашифрованный текст, почти один контейнер, один домен, встроенный
Postgres/SQLite, без MinIO/coturn/LiveKit.** Каждая галочка добавляет нужную ей
инфраструктуру.

## Спринты

- **Спринт 0 — Фундамент фиче-флагов.** Серверные `FEATURE_*` гейтят группы
  роутов + `GET /capabilities`; клиент прячет выключенные UI (кнопка звонка,
  вложения, вкладки стикеров/GIF). Env-флаги для десктопа уже есть
  (`build:selfhost`, 0.9.3) — распространить на Android.
- **Спринт 1 — Lite-профили compose.** `docker-compose.lite.yml` (db+api+web+caddy);
  MinIO/coturn/LiveKit — только по профилю при включённом флаге. Один домен
  (single-origin, как в e2e-харнесе) → **одна** DNS-запись вместо пяти.
- **Спринт 2 — Установщик в один клик (галочки).** Кросс-платформенный
  интерактивный установщик (сначала Node CLI, Win/Mac/Linux): домен + **галочки**,
  генерит `.env` + секреты, выбирает профиль, запускает. `install.sh`/`install.ps1`.
- **Спринт 3 — Медиа в Lite без MinIO.** Драйвер медиа на локальной ФС за тем же
  интерфейсом хранилища — `FEATURE_MEDIA` без запуска MinIO на маленьких серверах.
- **Спринт 4 — Нативные приложения под Lite + упаковка.** `build:selfhost` для
  Android; готовый Lite-образ + one-liner; квикстарт (EN/RU).
- **Спринт 5 — GUI-установщик и полировка.** Графический установщик с настоящими
  галочками (мини Tauri-приложение или веб-мастер первого запуска), дашборд
  здоровья, апгрейд Lite → full.

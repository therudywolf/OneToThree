# 🪶 OneToThree **Lite** — one-command self-host

> _English first, [Русская версия ниже](#-onetothree-lite--самохостинг-в-одну-команду)._

Lite stands up your **own** end-to-end encrypted messenger anywhere — your
laptop, a LAN box, or a public server — with only the features you want. A guided
installer asks a few questions and does the rest.

## Prerequisites

- **Docker** + Docker Compose v2 — https://docs.docker.com/get-docker/
- **Node.js 18+** (to run the installer) — https://nodejs.org/

## Install

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
npm run lite          # or: node scripts/lite/install.mjs  (Windows: scripts\lite\install.ps1)
```

The installer asks:

1. **Deployment mode** — OneToThree is E2EE and uses Web Crypto, which browsers
   only expose in a **secure context** (HTTPS, or plain HTTP on `localhost`). The
   three modes make that explicit:
   - **No domain — this machine** — plain HTTP on `http://localhost:<port>`.
     Everything works (incl. media) with zero setup, but only on this machine
     (a LAN IP over plain HTTP has no crypto). Great to try it.
   - **No domain — LAN / other devices** — **self-signed HTTPS** on
     `https://<LAN-IP>:<port>` (Caddy's internal CA), so phones/other PCs get a
     secure context and E2EE works. Browsers show a one-time cert warning — accept
     it; to silence it **and enable media**, install Caddy's local CA on each device.
   - **Domain** — a public server with **automatic HTTPS** (Let's Encrypt). Point
     an A record at the server and open ports 80/443.
2. **Host / port** (per mode; domain also asks for an ACME email).
3. **Features** — a checklist you toggle by number:

   | Feature | Default | Adds |
   | --- | --- | --- |
   | Media (photos/voice/files) | on | MinIO object storage |
   | Calls (voice/video) | off | LiveKit |
   | Stickers (import + create your own) | on | (uses media storage) |
   | GIF search (Tenor/Giphy) | on | third-party requests |
   | Push notifications | off | VAPID keys |
   | Two-factor auth (TOTP) | on | — |

It then generates secrets, writes `.env.lite` + `infra/lite/Caddyfile`, and (if you
say yes) launches the stack. First run pulls images + builds — a few minutes.

When it's up, open the URL it prints, **register the first account**, and make
yourself the owner (top `creator` tier — `role` is derived from `user_group`, so
set both):

```bash
docker compose --env-file .env.lite -f docker-compose.lite.yml exec db \
  psql -U forest -d forest -c "UPDATE users SET user_group='creator', role='admin' WHERE username='YOURNAME';"
```

## Everything is one origin

Web, the API, and the realtime WebSocket are all served from a **single origin**
behind Caddy — so Lite needs **one** hostname (or just `localhost`), not the five
subdomains the full deployment uses.

## Managing it

```bash
C="docker compose --env-file .env.lite -f docker-compose.lite.yml"
$C ps                 # status
$C logs -f api         # logs
$C down                # stop (keeps data volumes)
$C --profile media up -d --build   # restart after changing .env.lite
```

Re-run `npm run lite` any time to change mode/features (it rewrites `.env.lite`
and the Caddyfile).

## Notes

- **Local media** works out of the box (MinIO on `:9000`, CORS locked to your
  origin). On a **public domain**, front MinIO with your own `s3.<domain>` and
  set `OT_S3_PUBLIC_URL` — or turn media off. (A Docker-free local-filesystem
  media driver is planned — see the [roadmap](../project/ROADMAP_SELFHOST_LITE.md).)
- **Calls** are not bundled (a LiveKit SFU needs coturn + open UDP ports). When
  you turn calls on, the installer asks for your **LiveKit URL + API key/secret**
  and wires them to the API (`OT_LIVEKIT_*` in `.env.lite`) — the API hands the
  URL + a token to clients at call time, so no rebuild is needed. Leave them blank
  to fill in later. A bundled LiveKit is on the
  [roadmap](../project/ROADMAP_SELFHOST_LITE.md).
- Your data lives in Docker volumes (`lite_pgdata`, `lite_minio`). Never
  `docker compose down -v` unless you mean to erase it.
- Turning a feature off removes both its UI and the infra it needs.

---
---

# 🪶 OneToThree **Lite** — самохостинг в одну команду

Lite поднимает **твой** мессенджер со сквозным шифрованием где угодно — на
ноутбуке, домашнем сервере или публичном VPS — только с нужными функциями.
Мастер задаёт пару вопросов и делает всё сам.

## Требования

- **Docker** + Docker Compose v2 — https://docs.docker.com/get-docker/
- **Node.js 18+** (для установщика) — https://nodejs.org/

## Установка

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
npm run lite          # или: node scripts/lite/install.mjs  (Windows: scripts\lite\install.ps1)
```

Мастер спросит:

1. **Режим** — приложение E2EE и использует Web Crypto, который браузер даёт
   только в **защищённом контексте** (HTTPS, либо HTTP на `localhost`). Отсюда три
   режима:
   - **Без домена — эта машина** — обычный HTTP на `http://localhost:<порт>`.
     Всё работает (включая медиа) без настройки, но только на этой машине (по LAN-IP
     через голый HTTP крипто недоступно). Идеально попробовать.
   - **Без домена — LAN / другие устройства** — **самоподписанный HTTPS** на
     `https://<LAN-IP>:<порт>` (внутренний CA Caddy), чтобы у телефонов/других ПК
     был защищённый контекст и работало E2EE. Браузер один раз предупредит о
     сертификате — прими его; чтобы убрать предупреждение **и включить медиа**,
     установи локальный CA Caddy на каждом устройстве.
   - **Domain** — публичный сервер с **автоматическим HTTPS** (Let's Encrypt).
     Наведи A-запись на сервер и открой порты 80/443.
2. **Хост / порт** (по режиму; domain ещё спросит email для ACME).
3. **Функции** — список с галочками, переключаешь по номеру:

   | Функция | По умолчанию | Тянет |
   | --- | --- | --- |
   | Медиа (фото/голос/файлы) | вкл | хранилище MinIO |
   | Звонки (голос/видео) | выкл | LiveKit |
   | Стикеры (импорт + свои) | вкл | (использует хранилище) |
   | Поиск GIF (Tenor/Giphy) | вкл | сторонние запросы |
   | Push-уведомления | выкл | VAPID-ключи |
   | 2FA (TOTP) | вкл | — |

Дальше генерятся секреты, пишутся `.env.lite` + `infra/lite/Caddyfile`, и (если
согласишься) стек запускается. Первый запуск тянет образы и собирает — пара минут.

Когда поднялось — открой напечатанный URL, **зарегистрируй первый аккаунт** и
сделай себя владельцем (высшая группа `creator`; `role` производится из
`user_group`, поэтому ставим оба):

```bash
docker compose --env-file .env.lite -f docker-compose.lite.yml exec db \
  psql -U forest -d forest -c "UPDATE users SET user_group='creator', role='admin' WHERE username='ТВОЙ_НИК';"
```

## Всё на одном origin

Веб, API и realtime-WebSocket — всё за одним Caddy на **одном origin**, поэтому
Lite нужен **один** хост (или просто `localhost`), а не пять поддоменов, как в
полном деплое.

## Управление

```bash
C="docker compose --env-file .env.lite -f docker-compose.lite.yml"
$C ps                 # статус
$C logs -f api         # логи
$C down                # остановить (данные сохраняются)
$C --profile media up -d --build   # перезапуск после правок .env.lite
```

Запусти `npm run lite` заново когда угодно, чтобы поменять режим/функции.

## Заметки

- **Локальное медиа** работает из коробки (MinIO на `:9000`, CORS только на твой
  origin). На **публичном домене** выстави MinIO через свой `s3.<домен>` и задай
  `OT_S3_PUBLIC_URL` — либо выключи медиа. (Драйвер медиа на локальной ФС без
  Docker — в [роадмапе](../project/ROADMAP_SELFHOST_LITE.md).)
- **Звонки** не встроены (LiveKit-SFU требует coturn + открытые UDP-порты). При
  включении звонков установщик спросит **URL LiveKit + API-ключ/секрет** и
  пропишет их API (`OT_LIVEKIT_*` в `.env.lite`) — API отдаёт клиентам URL и токен
  во время звонка, пересборка не нужна. Можно оставить пустыми и заполнить позже.
  Встроенный LiveKit — в [роадмапе](../project/ROADMAP_SELFHOST_LITE.md).
- Данные — в Docker-томах (`lite_pgdata`, `lite_minio`). Не делай
  `docker compose down -v`, если не хочешь всё стереть.
- Выключение функции убирает и её UI, и нужную ей инфраструктуру.

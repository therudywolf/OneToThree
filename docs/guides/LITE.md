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
npm run lite:gui      # graphical wizard with real checkboxes (opens in your browser)
```

Prefer a terminal? The text installer asks the same questions:

```bash
npm run lite          # or: node scripts/lite/install.mjs  (Windows: scripts\lite\install.ps1)
```

### Graphical wizard (`npm run lite:gui`)

A tiny local web app (zero dependencies, bound to `127.0.0.1` only — never exposed
to the network) that walks you through setup with real checkboxes:

- **macOS / Linux:** `./scripts/lite/lite-gui.sh`
- **Windows:** `powershell -ExecutionPolicy Bypass -File scripts\lite\lite-gui.ps1`
- **Any OS:** `npm run lite:gui`

It checks Docker is present, lets you pick a mode and tick features, writes the
same `.env.lite` + `infra/lite/Caddyfile`, then (one click) runs `docker compose`
while streaming the build log live, and finishes with a health dashboard. Enabling
**Push** generates a VAPID keypair for you automatically.

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
and the Caddyfile). It **keeps the secrets of an existing install** — the
database and MinIO passwords, the JWT secret, the TOTP wrap key and the VAPID
pair. It has to: Postgres and MinIO only apply their root credentials the first
time their volume is created, so a fresh password would leave the stack unable
to authenticate against its own data — and a new TOTP wrap key would make every
enrolled 2FA secret undecryptable.

## Notes

- **Local media** works out of the box (MinIO on `:9000`, CORS locked to your
  origin). On a **public domain**, front MinIO with your own `s3.<domain>` and
  set `OT_S3_PUBLIC_URL` — or turn media off. (A Docker-free local-filesystem
  media driver is planned — see the [roadmap](../project/ROADMAP_SELFHOST_LITE.md).)
- **Calls.** With no SFU configured, calls ride the **app WebSocket** as
  pairwise-encrypted audio — no TURN, no extra ports, nothing to open. That is
  fine for one-to-one and small groups; it is a mesh, so every participant sends
  a copy to every other one.
  For bigger groups, point Lite at a **LiveKit** SFU (not bundled — it needs
  coturn and open UDP ports). Turn calls on and the installer asks for the
  **LiveKit URL + API key/secret**, writes them as `OT_LIVEKIT_*` and switches
  the API to `self_hosted` so it actually uses them. Group calls then go through
  the SFU; one-to-one keeps the WebSocket relay. Leave the URL blank to stay on
  the relay. A bundled LiveKit is on the
  [roadmap](../project/ROADMAP_SELFHOST_LITE.md).
- **`local` mode publishes on `127.0.0.1` only** — it means *this machine*, so
  it is not exposed to your network. (It also avoids a Docker Desktop quirk on
  Windows where the IPv6 listener accepts the connection and then answers
  nothing, which made `http://localhost:<port>` fail outright.) Use **LAN** mode
  to reach it from other devices.
- Your data lives in Docker volumes (`lite_pgdata`, `lite_minio`). Never
  `docker compose down -v` unless you mean to erase it.
- Turning a feature off removes both its UI and the infra it needs.

## Verified

Against a freshly installed `local` instance, with two real browsers:
registration, group creation with a client-side key, messages decrypting both
ways, an image attachment, a key rotation that keeps the pre-rotation history
and media readable, a direct message over the Double Ratchet, linking a second
device, and recovering an account from its 24-word phrase — 27/27.

Reproduce with the live harness (see `scripts/e2e-live/README.md`):

```bash
APP_URL=http://localhost:8443 API_URL=http://localhost:8443/api \
  ONLY=group,media,rotation,dm,devicelink,recovery node scripts/e2e-live/run.mjs
```

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

Запусти `npm run lite` заново когда угодно, чтобы поменять режим/функции. Он
**сохраняет секреты уже поставленного инстанса** — пароли базы и MinIO, JWT-секрет,
ключ шифрования TOTP и пару VAPID. Иначе никак: Postgres и MinIO применяют
root-пароль только при первом создании тома, поэтому новый пароль оставил бы стек
без доступа к собственным данным, а новый ключ TOTP сделал бы нерасшифровываемыми
все заведённые секреты 2FA.

## Заметки

- **Локальное медиа** работает из коробки (MinIO на `:9000`, CORS только на твой
  origin). На **публичном домене** выстави MinIO через свой `s3.<домен>` и задай
  `OT_S3_PUBLIC_URL` — либо выключи медиа. (Драйвер медиа на локальной ФС без
  Docker — в [роадмапе](../project/ROADMAP_SELFHOST_LITE.md).)
- **Звонки.** Без SFU звук идёт **по тому же WebSocket** попарно зашифрованными
  кадрами — ни TURN, ни лишних портов открывать не нужно. Для 1:1 и небольших
  групп этого достаточно; это меш, поэтому каждый участник шлёт копию каждому.
  Для групп побольше подключи **LiveKit** (не встроен — ему нужны coturn и
  открытые UDP-порты). Включи звонки, установщик спросит **URL LiveKit +
  API-ключ/секрет**, запишет их в `OT_LIVEKIT_*` и переведёт API в `self_hosted`,
  чтобы он их действительно использовал. Тогда групповые звонки идут через SFU,
  а 1:1 остаётся на relay. Оставь URL пустым — останешься на relay. Встроенный
  LiveKit — в [роадмапе](../project/ROADMAP_SELFHOST_LITE.md).
- **Режим `local` слушает только `127.0.0.1`** — это значит «только эта машина»,
  и в сеть он не выставляется. (Заодно обходится особенность Docker Desktop на
  Windows, где IPv6-слушатель принимает соединение и ничего не отвечает, из-за
  чего `http://localhost:<порт>` просто не открывался.) Чтобы зайти с других
  устройств — режим **LAN**.
- Данные — в Docker-томах (`lite_pgdata`, `lite_minio`). Не делай
  `docker compose down -v`, если не хочешь всё стереть.
- Выключение функции убирает и её UI, и нужную ей инфраструктуру.

## Проверено

На свежепоставленном инстансе в режиме `local`, двумя настоящими браузерами:
регистрация, создание группы с клиентским ключом, расшифровка сообщений в обе
стороны, вложение-картинка, ротация ключа с сохранением доступа к прежней
истории и медиа, личное сообщение через Double Ratchet, привязка второго
устройства и восстановление аккаунта по фразе из 24 слов — 27/27.

Воспроизвести (см. `scripts/e2e-live/README.md`):

```bash
APP_URL=http://localhost:8443 API_URL=http://localhost:8443/api \
  ONLY=group,media,rotation,dm,devicelink,recovery node scripts/e2e-live/run.mjs
```

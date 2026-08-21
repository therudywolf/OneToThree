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
npm run lite
```

**No terminal at all?** Double-click the launcher for your system — it checks the
prerequisites, tells you where to get anything missing, and opens the same setup:

| Windows | macOS | Linux |
|---|---|---|
| `scripts\lite\install.cmd` | `scripts/lite/install.command` | `bash scripts/lite/install.sh` |

(The graphical wizard has launchers too: `lite-gui.ps1`, `lite-gui.command`,
`lite-gui.sh`.)

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
   | Guest links (meetings / temp chats) | off | needs Calls + LiveKit for guest CALLS |

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

### Media backends

The installer asks where photos, voice notes and stickers should live.

| | **Files on this server** (default) | **Bundled MinIO** |
|---|---|---|
| Containers | none extra | one more |
| To configure | nothing | a public URL the browser can reach |
| Where the bytes are | `lite_media` volume, `<bucket>/<key>` | `lite_minio` volume |
| Backup | a directory copy | a directory copy |
| Links | signed by the API, expire in minutes | presigned S3, expire in minutes |

**Files on this server** is the default and the recommendation. The API serves
media from its own origin over links that carry an expiring signature — the same
capability model a presigned S3 URL has, minus the second container and minus
the question that stops more self-hosters than everything else combined: *what
is the public URL of your object storage?* Getting that wrong produces an
install that looks completely healthy and in which no picture ever loads.

It also serves media slightly more carefully than the object store does: the
`Content-Type` comes from an allow-list keyed on the file extension rather than
from whatever the uploader stored, everything that is not an image, video or
audio file is sent as a download, and `nosniff` is always set.

**Bundled MinIO** stays available (`OT_MEDIA_DRIVER=s3`), and an install created
before the local driver existed keeps it automatically — switching would point a
working stack at an empty directory. Move the files yourself first if you want
to change.

### Calls

One-to-one calls need nothing extra: the audio rides the **app WebSocket** as
pairwise-encrypted media — no TURN, no extra ports, nothing to open.

Group calls need an SFU, and the installer offers three answers:

- **The bundled one** (default). Adds a `livekit` container. Signalling is
  proxied by Caddy on the address you already have (`/livekit`), so there is no
  second hostname and no second certificate. Media needs exactly **one UDP port,
  7882** — published on loopback in `local` mode and on all interfaces
  otherwise. On a public server that is the one firewall rule to open; if calls
  connect and nobody can be heard, that port is the first thing to check.
- **A LiveKit you already run.** Enter its URL and API key/secret; no container
  is started.
- **One-to-one only.** Group calls fall back to the WebSocket relay, which is a
  mesh — every participant sends a copy to every other one.

The bundled SFU is told which address to advertise (`node_ip` in
`infra/lite/livekit.yaml`, written by the installer): a container on a bridge
network otherwise advertises an address no browser can reach, which is the
reason "just add LiveKit to the compose file" does not work.
- **`local` mode publishes on `127.0.0.1` only** — it means *this machine*, so
  it is not exposed to your network. (It also avoids a Docker Desktop quirk on
  Windows where the IPv6 listener accepts the connection and then answers
  nothing, which made `http://localhost:<port>` fail outright.) Use **LAN** mode
  to reach it from other devices.
- Your data lives in Docker volumes (`lite_pgdata`, `lite_media`, and
  `lite_minio` on the object-store backend). Never `docker compose down -v`
  unless you mean to erase it.
- Turning a feature off removes both its UI and the infra it needs.
- **The first admin.** The installer asks for a handle and writes it as
  `OT_ADMIN_USERNAME` (→ `ADMIN_BOOTSTRAP_USERNAME` in the API). Register that
  handle in the app, restart the API once, and it becomes the instance owner.
  The promotion only fires while there is no owner yet, so the variable is
  inert afterwards and safe to leave. It never creates an account — and because
  it matches on the handle, register that handle BEFORE naming it here if your
  instance takes open sign-ups. Leave it blank and the installer prints the psql
  one-liner instead.
- **Backups.** `npm run lite:backup` writes `backups/lite-<ts>.tar.gz`: the whole
  Postgres cluster, your media (the local directory or the MinIO data directory,
  whichever this install uses), and `.env.lite`. Restore with
  `RESTORE_CONFIRM=YES npm run lite:restore backups/lite-….tar.gz`.
  The archive **contains your secrets** — DB password, JWT secret, TOTP wrap
  key — because a dump without them restores a database nobody can read
  (every session invalid, every TOTP secret undecryptable). Keep it as safe
  as the server. The production scripts (`scripts/backup*.sh`) do NOT work
  against Lite: they resolve a different compose file and project.
- **Turning knobs without a redeploy.** `/admin` -> CONFIG edits open
  registration, guest-link TTL, meeting seats and the guest caps at runtime.
  Those overrides beat `.env.lite` until reset; feature flags stay env-only.

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
npm run lite:gui      # графический мастер с настоящими галочками (откроется в браузере)
```

Привычнее в терминале? Текстовый установщик спрашивает то же самое:

```bash
npm run lite
```

**Терминала не хочется?** Запусти двойным щелчком — он проверит, что всё
установлено, подскажет ссылки на недостающее и откроет ту же установку:

| Windows | macOS | Linux |
|---|---|---|
| `scripts\lite\install.cmd` | `scripts/lite/install.command` | `bash scripts/lite/install.sh` |

(У графического мастера тоже есть свои: `lite-gui.ps1`, `lite-gui.command`,
`lite-gui.sh`.)

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
   | Медиа (фото/голос/файлы) | вкл | ничего (файлы на диске) либо MinIO |
   | Звонки (голос/видео) | выкл | встроенный LiveKit либо свой |
   | Стикеры (импорт + свои) | вкл | (использует хранилище) |
   | Поиск GIF (Tenor/Giphy) | вкл | сторонние запросы |
   | Push-уведомления | выкл | VAPID-ключи |
   | 2FA (TOTP) | вкл | — |
   | Гостевые ссылки (встречи / временные чаты) | выкл | для гостевых ЗВОНКОВ нужны Звонки + LiveKit |

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

### Где лежит медиа

Установщик спрашивает, где хранить фото, голосовые и стикеры.

| | **Файлами на этом сервере** (по умолчанию) | **Во встроенном MinIO** |
|---|---|---|
| Контейнеров | ни одного лишнего | на один больше |
| Что настраивать | ничего | публичный URL, до которого дотянется браузер |
| Где байты | том `lite_media`, `<bucket>/<key>` | том `lite_minio` |
| Бэкап | копия каталога | копия каталога |
| Ссылки | подписывает API, живут минуты | presigned S3, живут минуты |

**Файлами на этом сервере** — по умолчанию и рекомендуется. API отдаёт медиа со
своего же origin по ссылкам с подписью и сроком годности: та же модель «ссылка и
есть разрешение», что у presigned S3, но без второго контейнера и без вопроса, о
который спотыкается больше людей, чем обо всё остальное вместе взятое — *какой у
твоего объектного хранилища публичный URL?* Неверный ответ даёт инстанс, который
выглядит полностью здоровым и в котором не грузится ни одна картинка.

И отдаёт он чуть аккуратнее, чем объектное хранилище: `Content-Type` берётся из
белого списка по расширению, а не из того, что записал загружающий; всё, что не
картинка, видео или звук, уходит как скачивание; `nosniff` стоит всегда.

**Встроенный MinIO** никуда не делся (`OT_MEDIA_DRIVER=s3`), и инстанс, поставленный
до появления локального драйвера, остаётся на нём сам — переключение направило бы
рабочий стек в пустой каталог. Хочешь сменить — сначала перенеси файлы руками.

### Звонки

Для 1:1 ничего лишнего не нужно: звук идёт **по тому же WebSocket** попарно
зашифрованными кадрами — ни TURN, ни открытых портов.

Групповым нужен SFU, и установщик предлагает три ответа:

- **Встроенный** (по умолчанию). Добавляет контейнер `livekit`. Сигналинг
  проксирует Caddy на том же адресе, что и всё остальное (`/livekit`), поэтому
  ни второго хоста, ни второго сертификата не нужно. Медиа нужен ровно **один
  UDP-порт, 7882** — в режиме `local` он на loopback, в остальных на всех
  интерфейсах. На публичном сервере это единственное правило файрвола; если
  звонок соединяется, а никого не слышно — проверять надо именно его.
- **Свой LiveKit.** Вводишь URL и ключ/секрет; контейнер не поднимается.
- **Только 1:1.** Групповые падают на WebSocket-relay, а это меш — каждый шлёт
  копию каждому.

Встроенному SFU установщик прописывает, какой адрес анонсировать (`node_ip` в
`infra/lite/livekit.yaml`): контейнер в bridge-сети иначе анонсирует адрес, до
которого не дотянется ни один браузер — по этой причине «просто добавить LiveKit
в compose» и не работает.
- **Режим `local` слушает только `127.0.0.1`** — это значит «только эта машина»,
  и в сеть он не выставляется. (Заодно обходится особенность Docker Desktop на
  Windows, где IPv6-слушатель принимает соединение и ничего не отвечает, из-за
  чего `http://localhost:<порт>` просто не открывался.) Чтобы зайти с других
  устройств — режим **LAN**.
- Данные — в Docker-томах (`lite_pgdata`, `lite_media`, а на объектном
  хранилище ещё и `lite_minio`). Не делай `docker compose down -v`, если не
  хочешь всё стереть.
- Выключение функции убирает и её UI, и нужную ей инфраструктуру.
- **Первый администратор.** Установщик спрашивает ник и пишет его в
  `OT_ADMIN_USERNAME` (→ `ADMIN_BOOTSTRAP_USERNAME` у API). Зарегистрируй
  этот ник в приложении, перезапусти api один раз — и он станет владельцем
  инстанса. Повышение срабатывает, только пока владельца нет, дальше
  переменная безвредна. Аккаунт она не создаёт — и, поскольку ищет по нику,
  на сервере с открытой регистрацией сначала займи этот ник сам, а потом
  указывай его здесь. Оставишь пустым — установщик напечатает однострочник для
  psql, как раньше.
- **Бэкапы.** `npm run lite:backup` пишет `backups/lite-<ts>.tar.gz`: весь
  кластер Postgres, медиа (локальный каталог или каталог MinIO — смотря что у
  этого инстанса) и `.env.lite`.
  Восстановление —
  `RESTORE_CONFIRM=YES npm run lite:restore backups/lite-….tar.gz`.
  В архиве **лежат секреты** — пароль БД, JWT-секрет, ключ обёртки TOTP:
  без них восстановленную базу невозможно прочитать (все сессии
  недействительны, все TOTP-секреты не расшифровываются). Храни архив так
  же бережно, как сам сервер. Прод-скрипты (`scripts/backup*.sh`) для Lite
  НЕ работают: они смотрят в другой compose-файл и другой проект.
- **Ручки без передеплоя.** `/admin` -> CONFIG меняет открытую регистрацию,
  TTL гостевой ссылки, места во встрече и потолки гостей на лету. Эти
  переопределения сильнее `.env.lite`, пока их не сбросят; флаги фич
  остаются только в окружении.

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

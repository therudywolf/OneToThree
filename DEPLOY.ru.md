# OneToThree — Деплой, обновление и Android

Практический гайд: первый запуск, обновление продакшна, сборка Android APK.

**[English version → DEPLOY.md](./DEPLOY.md)**

---

## Содержание

- [Первый запуск](#первый-запуск)
  - [Требования](#требования)
  - [1 · Клонировать репозиторий](#1--клонировать-репозиторий)
  - [2 · Настроить DNS](#2--настроить-dns)
  - [3 · Открыть порты файрвола](#3--открыть-порты-файрвола)
  - [4 · Запустить](#4--запустить)
  - [5 · Создать первого администратора](#5--создать-первого-администратора)
- [Обновление](#обновление)
  - [Одна команда](#одна-команда)
  - [Что происходит внутри](#что-происходит-внутри)
  - [Откат](#откат)
- [Android APK](#android-apk)
  - [Установить готовый APK](#установить-готовый-apk)
  - [Собрать из исходников](#собрать-из-исходников)
  - [Установка через ADB (Windows)](#установка-через-adb-windows)

---

## Первый запуск

### Требования

| Ресурс | Минимум |
|--------|---------|
| ОС | Linux (рекомендуется Ubuntu 22.04+) |
| CPU | 2 vCPU |
| RAM | 4 ГБ |
| Диск | 20 ГБ SSD |
| Docker | Engine 24+ с Compose v2 |
| Домен | 1 домен, 5 DNS A-записей (см. ниже) |

Установить Docker, если его нет:

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # должно быть ≥ 2.x
```

---

### 1 · Клонировать репозиторий

```bash
git clone https://github.com/therudywolf/OneToThree.git
cd OneToThree
```

---

### 2 · Настроить DNS

Создайте **пять** A-записей, указывающих на IP вашего сервера:

| Запись | Прокси Cloudflare |
|--------|------------------|
| `вашдомен.com` | Оранжевое облако (проксирование) — можно |
| `api.вашдомен.com` | Оранжевое облако (проксирование) — можно |
| `s3.вашдомен.com` | Оранжевое облако (проксирование) — можно |
| `turn.вашдомен.com` | **Серое облако — ОБЯЗАТЕЛЬНО** |
| `lk.вашдомен.com` | **Серое облако — ОБЯЗАТЕЛЬНО** |

> `turn.*` и `lk.*` **не должны** проксироваться Cloudflare. Прокси блокирует
> UDP-пакеты — TURN-релей и медиапоток LiveKit перестанут работать.

---

### 3 · Открыть порты файрвола

```bash
# HTTP + HTTPS (Caddy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# TURN / STUN (coturn — обход NAT)
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp

# LiveKit SFU — медиапоток и ICE/TCP-фолбек
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp

sudo ufw reload
```

---

### 4 · Запустить

```bash
chmod +x ./startup.sh
./startup.sh
```

При первом запуске скрипт делает всё автоматически:

1. Проверяет наличие Docker, openssl, curl
2. Спрашивает домен, ACME email, публичный IP сервера и контактный email для VAPID
3. **Генерирует все секреты** — пароль БД, MinIO, JWT, TURN, VAPID-ключи, LiveKit API key/secret
4. Записывает `.env.prod` со всеми нужными значениями (включая `DOMAIN=` для Caddyfile)
5. Собирает и запускает 8 контейнеров: Caddy, Next.js, Fastify API, PostgreSQL, Redis, MinIO, coturn, LiveKit
6. Ожидает прохождения health-проверок
7. **Показывает учётные данные один раз** — немедленно скопируйте их в менеджер паролей

> Первый запуск занимает 3–7 минут (загрузка Docker-образов + TLS-сертификат от Let's Encrypt).

---

### 5 · Создать первого администратора

1. Откройте `https://вашдомен.com` в браузере
2. Зарегистрируйте аккаунт
3. Повысьте его до администратора:

```bash
docker exec -it forestmessenger-db-1 psql -U forest -d forest \
  -c "UPDATE users SET role='admin' WHERE username='ВАШ_НИК';"
```

4. Выйдите и войдите снова, затем откройте `/admin`

### Гостевые ссылки (опционально, по умолчанию выключено)

Одноразовые гостевые ссылки (гость на созвоне + временный чат — см.
`docs/project/GUEST_MODE_CONCEPT.ru.md`) включаются явно:

1. Задайте `FEATURE_GUESTS=1` в окружении api-сервиса (для гостей на созвоне
   также нужны работающие звонки: `FEATURE_CALLS` + настроенный LiveKit).
   Опционально `FEATURE_OPEN_REGISTRATION=0` — закрыть самостоятельную
   регистрацию, чтобы гостевые ссылки стали единственной дверью для чужих.
2. **Чеклист периметра** (если ваш reverse proxy / Anubis / CrowdSec настроены
   по путям): пропустите `/guest/*` (публичные страницы входа) и
   `/api/guest/*` (resolve/knock/poll/enter). Anubis proof-of-work ПЕРЕД
   `/guest/*` рекомендуется оставить — это единственная анонимная поверхность
   приложения. Полезен CrowdSec-сценарий на всплески `POST /api/guest/knock`
   и `/api/guest/enter` с одного IP.
3. Ручки (env, дефолты): `GUEST_LINK_TTL_HOURS=24`, `GUEST_CHAT_TTL_HOURS=12`,
   `GUEST_SESSION_TTL_HOURS=12`, `GUEST_OFFLINE_GRACE_MIN=60`,
   `GUEST_MAX_LINKS_PER_USER=20`, `GUEST_MAX_ACTIVE=50`,
   `GUEST_MSG_PER_MINUTE=20`.

---

## Обновление

### Одна команда

```bash
# Рекомендуется: сначала сделайте резервную копию
./startup.sh backup

# Обновление
./startup.sh update
```

Занимает 2–5 минут. Ваши данные в безопасности — базы данных и медиафайлы
хранятся в Docker-томах, которые не затрагиваются при пересборке образов.

---

### Что происходит внутри

`./startup.sh update` выполняет следующее:

1. Запускает `doctor`: git, Docker, env, compose config и место на диске
2. Делает `git fetch --all --prune` и ff-only pull текущей ветки
3. Синхронизирует `DOMAIN` и все производные переменные в `.env.prod`
4. Собирает и запускает `db-migrate` идемпотентно
5. Пересобирает/перезапускает только затронутые сервисы или все основные через `--full`
6. Выполняет health, API `/health`, CSP и опциональную TURN TLS проверку

Полезные режимы: `--full`, `--no-pull`, `--no-cache`, `--skip-smoke`, `--skip-turn-sync`.

> **Никогда** не запускайте `docker compose down -v` — флаг `-v` удаляет все тома с данными.

---

### Точечный передеплой (только web/api)

Когда менялся только код приложения, `scripts/deploy-prod.sh` пересобирает
именно эти образы: сначала прогоняет миграции, проставляет штамп сборки и потом
проверяет, что и API, и клиентский бандл сообщают ту версию, которую вы собрали.

```bash
setsid nohup bash scripts/deploy-prod.sh > /tmp/deploy.log 2>&1 < /dev/null &
```

Два правила, которые скрипт теперь соблюдает сам, — нарушение каждого уже
роняло прод:

- **Один деплой за раз.** Скрипт откажется стартовать, пока идёт другой деплой —
  его собственный или голый `docker compose … up --build`. Две сборки, дошедшие
  до подмены контейнеров одновременно, оставляют api удалённым и не поднятым.
  Обойти можно через `FORCE=1`, если вы уверены, что второй процесс мёртв.
- **Не деплойте голым `docker compose up --build`.** Он пропускает миграции и
  запекает `APP_VERSION=dev` в обе половины: баннер «доступна новая сборка»
  молча умирает (`version-check.ts` не сравнивает версии для `dev`), и понять,
  какой коммит крутится на проде, становится нельзя.

Запускайте отвязанно, как в примере выше: если ssh-сессия отвалится посреди
сборки, запущенный ею compose продолжит работать сиротой, и следующая попытка
войдёт с ним в гонку.

---

### Откат

Если обновление сломало что-то:

```bash
# 1. Найти предыдущий рабочий коммит
git log --oneline -10

# 2. Вернуться к этому коммиту
git checkout <HASH>

# 3. Пересобрать
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  up -d --build --remove-orphans

# 4. Если миграция сломала БД — восстановить из резервной копии
gunzip -c backups/db_ГГГГММДД_HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

Вернуться к отслеживанию `main` после исправления проблемы:

```bash
git checkout main
git pull
./startup.sh update
```

---

## Android APK

### Установить готовый APK

Готовые debug-APK находятся в [`releases/android/`](./releases/android/).

**Шаги:**

1. Включите **Параметры разработчика**:
   Настройки → О телефоне → нажмите *Номер сборки* семь раз
2. Включите **Отладку по USB**: Настройки → Параметры разработчика → Отладка по USB
3. Подключите по USB и нажмите **Разрешить** в диалоге на телефоне
4. Установите свежий APK через ADB:

```bash
adb install -r -d releases/android/onetothree-debug.apk
```

5. Откройте приложение → введите URL вашего сервера (например `https://вашдомен.com`) → зарегистрируйтесь

---

### Собрать из исходников

**Требования на машине сборки:**

| Инструмент | Версия |
|-----------|--------|
| Docker | Обязателен; используется Android builder image, если локальный SDK не настроен |
| Java JDK | Опционально для нативной сборки на хосте; 17 или 21 |
| Android SDK | Опционально для нативной сборки на хосте; Build-Tools 34+ |
| `ANDROID_HOME` | Опционально; если не задан, используется Docker-сборка |

**Шаги:**

```bash
# 1. Убедитесь, что в .env.prod настроен URL сервера
#    NEXT_PUBLIC_API_URL=https://api.вашдомен.com

# 2. Собрать debug APK
./startup.sh build-apk

# 3. Или собрать подписанный release APK (нужен keystore)
./startup.sh build-apk-release /путь/к/release.keystore
# Перед запуском установите переменные:
#   export RELEASE_STORE_PASSWORD=...
#   export RELEASE_KEY_ALIAS=upload
#   export RELEASE_KEY_PASSWORD=...
```

На Windows самый короткий путь:

```powershell
.\apkbuild.ps1
.\apkbuild.ps1 -Release -KeystorePath C:\keys\onetothree.jks
```

APK сохраняется в `releases/android/`: `onetothree-debug.apk` / `onetothree-release.apk`, неизменяемая копия `onetothree-<type>-YYYYMMDD-HHMM-<gitsha>.apk` и `.sha256` для каждого файла.

**Что делает скрипт сборки:**

1. Читает `NEXT_PUBLIC_API_URL` и другие переменные из `.env.prod`
2. Запускает `next build` с `NEXT_EXPORT=1` — статический экспорт в `client/out/`
3. Запускает `cap sync android` — копирует веб-ассеты в Android-проект Capacitor
4. Запускает `./gradlew assembleDebug` (или `assembleRelease`) — собирает APK

---

### Установка через ADB (Windows)

Используйте Android platform-tools на любой ОС:

```bash
adb devices
adb install -r -d releases/android/onetothree-debug.apk
```

**Частые ошибки:**

| Ошибка | Решение |
|--------|---------|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.onetothree.app`, затем установить снова |
| `device unauthorized` | Разблокируйте телефон → нажмите «Разрешить» в диалоге отладки |
| `device offline` | Отключите и снова подключите USB-кабель |
| ADB не найден | Установите [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) и добавьте в PATH |

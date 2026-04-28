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
chmod +x ./start.sh
./start.sh
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

---

## Обновление

### Одна команда

```bash
# Рекомендуется: сначала сделайте резервную копию
./start.sh backup

# Обновление
./start.sh update
```

Занимает 2–5 минут. Ваши данные в безопасности — базы данных и медиафайлы
хранятся в Docker-томах, которые не затрагиваются при пересборке образов.

---

### Что происходит внутри

`./start.sh update` выполняет следующее:

1. `git pull origin main` — загружает последний код
2. Синхронизирует `DOMAIN` и все производные переменные в `.env.prod` (ручное редактирование не нужно)
3. Генерирует отсутствующие секреты (например, новые ключи, добавленные в этой версии)
4. `docker compose up -d --build --remove-orphans` — пересобирает образы, перезапускает сервисы
5. Контейнер `db-migrate` автоматически применяет новые Drizzle ORM-миграции при старте

> **Никогда** не запускайте `docker compose down -v` — флаг `-v` удаляет все тома с данными.

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
./start.sh update
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
4. Запустите PowerShell-установщик (Windows) или используйте ADB напрямую:

```powershell
# Windows — из папки releases/android/:
.\install-apk.ps1
```

```bash
# Linux / macOS:
adb install -r -d releases/android/OneToThree-debug-2026-04-27.apk
```

5. Откройте приложение → введите URL вашего сервера (например `https://вашдомен.com`) → зарегистрируйтесь

---

### Собрать из исходников

**Требования на машине сборки:**

| Инструмент | Версия |
|-----------|--------|
| Java JDK | 17 или 21 |
| Android SDK | Build-Tools 34+ |
| `ANDROID_HOME` | переменная окружения → путь к SDK |
| Node.js | 20+ |

**Шаги:**

```bash
# 1. Убедитесь, что в .env.prod настроен URL сервера
#    NEXT_PUBLIC_API_URL=https://api.вашдомен.com

# 2. Собрать debug APK
./start.sh build-apk

# 3. Или собрать подписанный release APK (нужен keystore)
./start.sh build-apk-release /путь/к/release.keystore
# Перед запуском установите переменные:
#   export RELEASE_STORE_PASSWORD=...
#   export RELEASE_KEY_ALIAS=upload
#   export RELEASE_KEY_PASSWORD=...
```

APK сохраняется в `releases/android/onetothree-debug.apk` (или `onetothree-release.apk`).

**Что делает скрипт сборки:**

1. Читает `NEXT_PUBLIC_API_URL` и другие переменные из `.env.prod`
2. Запускает `next build` с `NEXT_EXPORT=1` — статический экспорт в `client/out/`
3. Запускает `cap sync android` — копирует веб-ассеты в Android-проект Capacitor
4. Запускает `./gradlew assembleDebug` (или `assembleRelease`) — собирает APK

---

### Установка через ADB (Windows)

PowerShell-скрипт `releases/android/install-apk.ps1` делает всё автоматически:

- Находит ADB в PATH или в стандартных расположениях Android SDK
- Показывает список подключённых устройств; предлагает выбрать если их несколько
- Определяет состояния `unauthorized`/`offline` с чёткими инструкциями
- Устанавливает через `adb install -r -d` и показывает подсказки при ошибках

```powershell
# Базовое использование — находит APK автоматически:
.\install-apk.ps1

# Конкретный APK:
.\install-apk.ps1 -ApkPath ".\onetothree-release.apk"

# Конкретное устройство (удобно с эмуляторами):
.\install-apk.ps1 -DeviceSerial "emulator-5554"
```

**Частые ошибки:**

| Ошибка | Решение |
|--------|---------|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | `adb uninstall com.onetothree.app`, затем установить снова |
| `device unauthorized` | Разблокируйте телефон → нажмите «Разрешить» в диалоге отладки |
| `device offline` | Отключите и снова подключите USB-кабель |
| ADB не найден | Установите [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) и добавьте в PATH |

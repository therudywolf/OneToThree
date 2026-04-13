# Forest Messenger

Самохостируемый мессенджер со сквозным шифрованием. Сервер хранит только зашифрованные данные — приватные ключи никогда не покидают браузер.

**[English documentation → README.md](./README.md)**

---

## Возможности

- **E2EE сообщения** — AES-GCM-256 на каждое сообщение, обмен ключами по ECDH, ключи хранятся в зашифрованном vault в браузере
- **Голосовые и видеозвонки** — WebRTC с TURN-релеем, ICE fallback, мониторинг качества соединения
- **Отправка файлов** — зашифрованная загрузка медиа в MinIO/S3, расшифровка на стороне клиента
- **Группы** — зашифрованное распределение группового ключа по участникам
- **Мультиустройство** — привязка устройств по QR-коду, отзыв доступа
- **2FA** — опциональный TOTP (RFC 6238)
- **PWA** — установка как приложение, оффлайн-баннер, push-уведомления через Web Push (VAPID)
- **Самохостинг** — один Docker Compose стек, автоматический TLS через Let's Encrypt (Caddy)

**Стек:** Next.js 16 · Fastify · PostgreSQL · MinIO · WebRTC · Caddy · coturn

---

## Быстрый старт

### Требования

- Linux VPS (рекомендуется 4+ vCPU, 4+ ГБ RAM)
- Docker + Docker Compose v2
- Домен, DNS-записи которого указывают на сервер
- Открытые порты **80**, **443**, **3478/tcp+udp**, **49152–65535/udp**

### 1. Клонирование и настройка

```bash
git clone -b ver2 https://github.com/therudywolf/OneToThree.git
cd OneToThree
cp .env.prod.example .env.prod
nano .env.prod
```

Заполните **6 обязательных полей** (помечены `← FILL IN` в файле):

| Переменная | Что указать |
|---|---|
| `POSTGRES_PASSWORD` | Надёжный пароль для базы данных |
| `MINIO_ROOT_PASSWORD` | Надёжный пароль для хранилища файлов |
| `CORS_ORIGIN` | Ваш домен: `https://ваш-домен.ru` |
| `ACME_EMAIL` | Email для уведомлений Let's Encrypt |
| `TURN_EXTERNAL_IP` | Публичный IP сервера: `curl -s ifconfig.me` |
| `TURN_PASSWORD` | Надёжный пароль для TURN-релея |

Всё остальное (`JWT_SECRET`, `WEBHOOK_SECRET`, VAPID-ключи) **генерируется автоматически** при первом запуске.

### 2. Настройка DNS

Укажите DNS-записи на IP сервера:

| Запись | Тип | Значение |
|---|---|---|
| `ваш-домен.ru` | A | IP сервера |
| `api.ваш-домен.ru` | A | IP сервера |
| `s3.ваш-домен.ru` | A | IP сервера |
| `turn.ваш-домен.ru` | A | IP сервера ← **только DNS, без прокси** |

> **Пользователи Cloudflare:** запись `turn.*` должна быть в режиме **«Только DNS» (серое облако)**. Оранжевый прокси блокирует UDP-трафик, необходимый для WebRTC-звонков. Остальные записи можно оставить проксированными.

### 3. Открытие портов

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:65535/udp
```

### 4. Запуск

```bash
chmod +x ./start.sh
./start.sh
```

Скрипт выполнит:
1. Автогенерацию недостающих секретов (`JWT_SECRET`, `WEBHOOK_SECRET`, VAPID-ключи)
2. Синхронизацию `TURN_PASSWORD` в `NEXT_PUBLIC_TURN_PASSWORD`
3. Сборку и запуск всех контейнеров
4. Ожидание прохождения health-checks
5. Вывод статуса стека

TLS-сертификаты получаются автоматически от Let's Encrypt. Первый запуск занимает 2–5 минут.

---

## Управление стеком

```bash
./start.sh              # Запуск / пересборка
./start.sh stop         # Остановить все контейнеры
./start.sh restart      # Перезапуск без пересборки
./start.sh logs         # Живые логи (все сервисы)
./start.sh status       # Статус контейнеров
./start.sh update       # git pull + пересборка (данные сохраняются)
./start.sh backup       # Дамп БД → backups/db_TIMESTAMP.sql.gz
```

### Обновление до новой версии

```bash
./start.sh update
```

Команда выполняет `git pull` и пересобирает образы. **Базы данных, файлы и TLS-сертификаты сохраняются** — они живут в именованных Docker-томах и никогда не затрагиваются пересборкой.

> Никогда не запускайте `docker compose down -v`, если не хотите удалить все данные.

---

## Первый администратор

После запуска стека зарегистрируйтесь через обычную форму, затем назначьте себя администратором:

```bash
./start.sh status   # убедитесь, что стек работает

docker compose -f docker-compose.prod.yml --env-file .env.prod exec db \
  psql -U forest -d forest \
  -c "UPDATE users SET role = 'admin' WHERE username = 'ваш_никнейм';"
```

После этого откройте `/admin` в браузере (нужно быть авторизованным).

---

## Резервное копирование и восстановление

**Создать резервную копию:**
```bash
./start.sh backup
# Сохраняется в: backups/db_YYYYMMDD_HHMMSS.sql.gz
```

**Восстановить из резервной копии:**
```bash
gunzip -c backups/db_20260101_120000.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T db psql -U forest -d forest
```

---

## Кастомный домен (Caddyfile)

Отредактируйте `Caddyfile`, заменив `onetothree.ru` на ваш домен, затем перезапустите:

```bash
./start.sh restart
```

---

## Устранение неполадок

| Симптом | Решение |
|---|---|
| Caddy не получает сертификат | Убедитесь, что DNS указывает на этот сервер, порты 80/443 открыты. Проверьте: `./start.sh logs` → фильтр caddy |
| WebRTC-звонки не работают | Убедитесь, что DNS `turn.*` **не проксируется** через Cloudflare. Проверьте `TURN_EXTERNAL_IP` |
| Цикл редиректа `/login` | Добавьте `COOKIE_DOMAIN=.ваш-домен.ru` в `.env.prod`, пересоберите api |
| `relation "users" does not exist` | Ошибка миграции — проверьте: `docker compose logs db-migrate` |
| Медиа показывает «Файл истёк» | Объект удалён политикой хранения или отправитель должен переотправить |
| Неверные IP в логах | Убедитесь, что `TRUST_PROXY=1` указан в `.env.prod` |

---

## Модель безопасности

- **Приватные ключи никогда не покидают браузер.** Vault шифруется через PBKDF2 + AES-GCM локально.
- **Сервер хранит только зашифрованные данные.** Сообщения, медиа и групповые ключи — непрозрачные блобы.
- **Аутентификация через ECDSA challenge-response.** Пароль на сервер не передаётся.
- **Медиа шифруется до загрузки** в MinIO.
- **WebRTC-сигнализация передаётся как непрозрачные данные** — сервер не парсит SDP.

Полная модель угроз: [SECURITY.md](./SECURITY.md). Потоки данных: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Справочник переменных окружения

Полный справочник: [`.env.prod.example`](./.env.prod.example)

| Переменная | Автогенерация | Обязательна |
|---|---|---|
| `POSTGRES_PASSWORD` | Нет | Да |
| `MINIO_ROOT_PASSWORD` | Нет | Да |
| `CORS_ORIGIN` | Нет | Да |
| `ACME_EMAIL` | Нет | Да |
| `TURN_EXTERNAL_IP` | Нет | Да |
| `TURN_PASSWORD` | Нет | Да |
| `JWT_SECRET` | Да | — |
| `WEBHOOK_SECRET` | Да | — |
| `VAPID_PUBLIC_KEY` | Да | — |
| `VAPID_PRIVATE_KEY` | Да | — |
| `DATABASE_URL` | Да (из POSTGRES_*) | — |

---

## Контакты

[Telegram](https://t.me/rudy_wolf) · [GitHub](https://github.com/therudywolf)

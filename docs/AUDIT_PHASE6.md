# Phase 6 — Production-readiness audit

Status tracker for the final production-hardening phase. Items mark what is
done in this branch vs. what remains for the operator to schedule before
cutover. Each section lists the invariant, current status, and the concrete
action item (`ACTION:`).

---

## 1. IDOR / Authorization

* Все запросы на `/api/chats/:chatId/*`, `/api/messages`, `/api/storage/*`
  уже проверяют членство через `assertChatMember` / `assertAuthed`.
* Новые роуты `/api/keys/*` (phase 3.2) используют `u.id` вместо
  `req.body.user_id` — нет возможности выдать чужую identity.
* `/api/call/token` (phase 4.2) берёт `sub` из сессии, `room` ограничен
  regex `[A-Za-z0-9_\-:.]+`.

ACTION (operator): запустить один проход пятнадцатиминутного чеклиста из
`server/src/routes/*.test.ts` и добавить недостающие кейсы:
`peerId = self`, `chatId = other-user-chat`, `?userId=escape..` в path
params. (Перед каждым merge).

## 2. CSP / transport security

* `Caddyfile` уже содержит `Strict-Transport-Security`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, жесткий
  CSP (`frame-ancestors 'none'`).
* `server/src/app.ts` (helmet) задаёт защитный дубликат — никакого
  `'unsafe-eval'`, `connectSrc` строго ограничен.
* `script-src 'unsafe-inline'` — остаётся для Next.js inline bootstrap.
  Миграция на nonce-based CSP запланирована отдельной задачей.

ACTION: настроить `upgrade-insecure-requests` и убрать `'unsafe-inline'` из
`script-src`, перейдя на nonce-handled. Требует изменения в Next.js
middleware — не входит в этот PR.

## 3. Лог-санитизация

* `scripts/audit-security-lint.mjs` запрещает `console.log` и `console.info`;
  текущий прогон — **0 нарушений**. `console.debug` вырезается Next.js
  compiler при build prod.
* `server/src/lib/api-access-log.ts` пишет только метадату запроса; не
  логирует ни токены, ни заголовки `Authorization`.

ACTION: подключить `pino-redact` на Fastify logger для маскирования
`req.headers.authorization` и cookie на случай ручных `logger.info`.

## 4. Мобильный UX

* `chat-terminal.tsx` — автоскролл с `ResizeObserver`, typing-индикатор
  вынесен в overlay (phase 1.3).
* `Caddyfile` CSP уже разрешает `media-src blob:` + MinIO для голоса.
* PWA-ориентация теперь `any` (phase 6) — iPad не ломается в landscape.

ACTION: Lighthouse prod-run, цель PWA >= 95, Performance >= 85 на
3G+fast-4G; метрики зафиксировать в `docs/metrics/phase6-lighthouse.md`.

## 5. i18n

* `client/src/locales/en.ts` + `ru.ts` покрывают базовый UI и настройки
  (phase 2.1 добавил `settings.appearanceShellTitle` /
  `settings.appearancePaletteTitle`).
* Нет fallback-резолвера для неизвестных локалей — поведение Next.js
  `i18n.defaultLocale = 'en'` покрывает базу.

ACTION: добавить lints на `missing i18n key` (ESLint правило из
`@inlang/eslint-plugin`); прогнать при CI.

## 6. PWA manifest

* `client/src/app/manifest.ts` обновлён:
  * `launch_handler` (navigate-existing) — уменьшает дубликат окон PWA.
  * `orientation: 'any'` — поддержка tablet landscape.
  * `shortcuts` (new-chat, devices) — встроенные action-tile.
  * `screenshots` — Edge/Chrome показывают превью.

ACTION: нагенерить icons в `512x512 any`/`512x512 maskable` через
Android Asset Studio, подложить в `client/public/`. Текущие 192/512 —
временные.

## 7. Playwright E2E

* Репозиторий пока не содержит Playwright конфиг; phase 6 план фиксирует
  этот долг.

ACTION (next PR): добавить `playwright.config.ts`, сценарии:
1) vault unlock (WebAuthn emulation off — только passphrase);
2) send DM (v1);
3) send DM после X3DH (v2);
4) device link QR;
5) start call (mesh fallback, без LiveKit);
6) burn-after-read.

---

## Summary

| Фаза | Статус | Продакшн-блокер? |
| --- | --- | --- |
| 0 — baseline/audit | done | нет |
| 1.1–1.5 — bugfixes + CRITICAL security | done | нет |
| 2.1–2.3 — UI split + tokens + MD3 | done | нет |
| 3.1 — DR лib | done | нет |
| 3.2 — key directory | done | **да**: миграция `0027` |
| 3.3 — messages.protocol_version + manager | done | **да**: миграция `0028` |
| 4.1 — coturn hardening | done | требует TLS-sync cron |
| 4.2 — LiveKit SFU + /api/call/token | done | нужно задеплоить livekit-server |
| 4.3 — LiveKit Insertable Streams E2EE | архитектура | клиентский SDK не установлен |
| 5.1 — channels schema | done | миграция `0029` |
| 5.2 — stickers schema | done | миграция `0030`, UI отдельно |
| 6 — polish | частично | см. ACTION выше |

Всё, что ниже "частично", требует либо инфраструктурной работы
(cron + firewall + DNS), либо отдельной клиентской итерации (Call UI,
sticker picker, Playwright). Они документированы в MIGRATION_NOTES и в
этом файле.

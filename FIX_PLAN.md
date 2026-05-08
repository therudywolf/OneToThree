# OneToThree — Fix Plan
**Составлен:** 2026-05-07  
**Область:** Critical bugs + Design system audit

---

## Диагностика по каждому пункту

### 1. APK не собирается

**Цепочка:**
```
npm run android:build:debug
  → android:sync
      → build:client:export   (NEXT_EXPORT=1 next build → пишет client/out/)
      → cap sync android       (копирует client/out/ в android/app/src/main/assets/public/)
  → build:debug --prefix mobile/capacitor
      → run-gradle.mjs assembleDebug
```

**Корневые причины (блокируют `next build`):**

| Файл | Проблема | Следствие |
|------|----------|-----------|
| `client/src/app/layout.tsx` | 44 null-байта (`\x00`) в конце файла | TS1127 "Invalid character" ×44 → build abort |
| `client/src/components/chat/chat-input.tsx` | Файл обрезан на строке 1359 (середина строки className) | TS17008 unclosed JSX `<form>`, TS1002 unterminated string |
| `client/src/lib/api/socket.ts` | Файл обрезан на строке 441 (середина `scheduleReconnect`) | TS1005 `}` expected |

**Все три файла в git HEAD тоже обрезаны** — восстановление из git недостаточно, нужно дописать.

---

### 2. Авторизация через PWA не работает

**Корневая причина:** те же три файла ломают `next build` → `sw.js` не генерируется с актуальными pre-cache манифестами → PWA устанавливается со сломанным ServiceWorker.

**Дополнительные точки:**

- Cookie `fm_session` должен иметь `SameSite=None; Secure` для Capacitor WebView  
  (в `MainActivity.java` `setAcceptThirdPartyCookies` включён — правильно, но cookie сам должен приходить с нужными атрибутами с сервера).
- `start_url: '/?source=pwa'` → если SW кеширует `/?source=pwa` отдельно от `/`, возникает miss. `cacheStartUrl: false` в `next.config.js` уже отключает это — правильно.
- CSP nonce в `middleware.ts` — нужно проверить, что nonce пробрасывается корректно после восстановления `layout.tsx`.

---

### 3. Импорт ключа не работает

**Bug 1: `post-register-vault-prompt.tsx` экспортирует без `username`:**
```ts
// Экспорт (post-register-vault-prompt.tsx:36)
{ userId, vault, exported_at }   // ← username ОТСУТСТВУЕТ

// Импорт (login-form.tsx:99)
{ username?: string; vault?: VaultBlob }  // ← data.username = undefined
```
Если пользователь не ввёл ник в поле handle ДО нажатия "импортировать" — `handle.trim()` пуст, `parseNickname` падает, `catch` показывает generic `settings.importFailed`.

**Bug 2: нет обратной совместимости с прямым blob (без обёртки):**  
Если пользователь передаёт сырой VaultBlob JSON (без поля `vault`), `data.vault?.ciphertextB64` = `undefined` → `throw 'INVALID_STRUCTURE'` без диагностики.

**Bug 3: ошибка поглощается без лога:**
```ts
} catch {
  setErrorLog(t('settings.importFailed'))  // нет e.message, нет console.error
}
```

---

### 4. Сжигаемое сообщение: неправильная точка отсчёта

**Текущее поведение:**
```ts
// chat-input.tsx:302
const makeBurnAt = (secs: number | null): string | null => {
  return new Date(Date.now() + secs * 1000).toISOString()  // ← отсчёт от ОТПРАВКИ
}
```
Сервер принимает `burn_at` как абсолютную метку → через 5 секунд после отправки сообщение исчезнет даже если никто не прочитал.

**Правильная модель:** таймер должен стартовать в момент первого прочтения (`read_at`).

**Необходимые изменения:**

| Слой | Что изменить |
|------|-------------|
| DB schema | Добавить `burn_duration_secs integer` в таблицу `messages` |
| Server send route | Принимать `burn_duration_secs` вместо/вместе с `burn_at` |
| `mark-message-read.ts` | При записи `read_at`: если есть `burnDurationSecs`, установить `burnAt = NOW() + burnDurationSecs * 1000` |
| WS broadcast | Включать `burn_at` в событие `message_read_update` |
| Client `makeBurnAt` | Передавать `burn_duration_secs: N` вместо `burn_at` |
| Client realtime hook | Обновлять `burn_at` сообщения при получении `message_read_update` |

---

### 5. Критические ошибки в коде — план исправления

#### 5.1 `layout.tsx` — null bytes
```bash
# Стрипнуть null-байты (Python safe replace)
python3 -c "
data = open('client/src/app/layout.tsx','rb').read()
clean = data.replace(b'\x00', b'')
open('client/src/app/layout.tsx','wb').write(clean)
print('stripped', data.count(b'\x00'), 'null bytes')
"
```

#### 5.2 `socket.ts` — восстановление обрезанной функции
Файл обрывается на строке 441: `const jit`  
Дописать хвост `scheduleReconnect` + закрыть класс:
```ts
    const jitter = Math.random() * capped * 0.3
    const delay = Math.round(capped + jitter)
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }
}
```

#### 5.3 `chat-input.tsx` — восстановление обрезанного JSX
Файл обрывается на строке 1359: `showSendOnMobile ? 'inline-flex' : 'hidd`  
Дописать:
```tsx
            showSendOnMobile ? 'inline-flex' : 'hidden'
          } md:inline-flex ${isMd3 ? 'order-5' : ''}`}
          onClick={() => void onSubmit({ preventDefault: () => {} } as React.FormEvent)}
          aria-label={t('chat.send')}
        >
          <SendHorizonal className="h-4 w-4" />
        </button>
      </div>
    </form>
  )
}
```

---

### 6. Design System — аудит

**Метрики нарушений:**

| Категория | Кол-во нарушений | Приоритет |
|-----------|-----------------|-----------|
| Unscoped `font-mono`/`font-sans` в компонентах | 413 вхождений | HIGH |
| Компонентные правила в `[data-theme]` (не токены) | ~30 блоков | HIGH |
| Отсутствие `[data-shell]` scoping в CSS | вся globals.css | HIGH |
| Hardcoded hex вне CSS переменных | ~20 значений | MEDIUM |
| `active-call-overlay.tsx`: unconditional `font-mono` (MD3 breaking) | 10+ строк | HIGH |

---

## Приоритизированный план работ

### Sprint 1 — Критические баги (блокируют всё)

**S1-1: Починить три поломанных файла**

```
Файл                              Действие
─────────────────────────────────────────────────────
layout.tsx                        strip 44 null bytes
socket.ts                         дописать scheduleReconnect tail + закрыть класс  
chat-input.tsx                    дописать send button + закрыть form JSX
```

После: `npm run typecheck` должен проходить без TS-ошибок по этим файлам.

**S1-2: Burn-from-read**

1. `server/src/db/schema.ts`: добавить `burnDurationSecs: integer('burn_duration_secs')`
2. `server/src/routes/messages.ts`: принимать `burn_duration_secs` в sendSchema
3. `server/src/lib/chat-message-persist.ts`: сохранять `burnDurationSecs`
4. `server/src/lib/mark-message-read.ts`: при `markMessageReadByReader` → если `burnDurationSecs`, set `burnAt = now + burnDurationSecs * 1000`; include `burn_at` в WS broadcast
5. Client `chat-input.tsx`: `makeBurnAt` → `makeBurnDuration` (возвращает `{ burn_duration_secs: N }`)
6. Client `use-send-message.ts`: передавать `burn_duration_secs` вместо `burn_at`
7. Client `use-chat-realtime.ts`: при `message_read_update` обновлять `burn_at` в store

**S1-3: Импорт ключа**

1. `post-register-vault-prompt.tsx`: добавить `username` в export payload
2. `login-form.tsx#handleVaultImport`:
   - поддержать `data.userId` как fallback (для старых экспортов без username)
   - добавить `console.error(e)` в catch-блок
   - если нет `data.vault` но есть `data.ciphertextB64` — обработать как raw blob
3. Добавить явное сообщение об ошибке: "Нет имени пользователя — введите ник перед импортом"

**S1-4: APK build**

После фиксов S1-1:
```bash
# Проверить что build:client:export не падает:
NEXT_EXPORT=1 NEXT_PUBLIC_API_URL=https://api.onetothree.ru \
  NEXT_PUBLIC_APP_URL=https://onetothree.ru \
  npx next build --webpack   # из client/

# Затем:
npm run android:build:debug
```

Задокументировать в README обязательные env vars для APK build.

**S1-5: PWA auth**

После S1-1 (layout.tsx fixed):
- Проверить `fm_session` cookie attributes на сервере: `SameSite=None; Secure; HttpOnly`
- Убедиться что Fastify `cookie` plugin создаёт cookie с этими флагами для production
- Проверить что `middleware.ts` nonce корректно пробрасывается через `layout.tsx`

---

### Sprint 2 — Design System (оба шелла)

#### S2-1: CSS Architecture refactor

**Принцип:** `[data-theme]` = только цветовые токены. `[data-shell]` = компонентные правила.

**Шаги:**

1. **Аудит `globals.css`** — найти все блоки `[data-theme="..."]` с non-token правилами (layout, font, padding, border-radius):
   ```
   [data-theme="cyberpunk2077"] .terminal-panel { ... }  → переместить в [data-shell="terminal"]
   [data-theme="retro"] body { font-family: ... }        → переместить в [data-shell="terminal"]
   [data-theme="retro"] * { letter-spacing: ... }        → переместить в [data-shell="terminal"]
   ```

2. **Добавить `[data-shell="md3"]` секцию** с базовыми MD3 правилами:
   ```css
   [data-shell="md3"] { font-family: var(--md3-font-sans); }
   [data-shell="md3"] .p13-bubble--mine { border-radius: 18px 18px 4px 18px; }
   [data-shell="terminal"] { font-family: var(--font-mono); }
   [data-shell="terminal"] .p13-bubble--mine { border-radius: 0; }
   ```

3. **Убрать hardcoded hex** — заменить на CSS variables:
   ```css
   /* Было: */
   background: #020305;
   /* Стало: */
   background: var(--void-deep, #020305);
   ```

#### S2-2: Component scoping в TSX

**Правило для всех компонентов:**
```tsx
// ❌ Нарушение — unconditional font-mono в MD3
<span className="font-mono text-[9px]">

// ✅ Правильно — scoped to shell
<span className={isMd3 ? 'text-[11px]' : 'font-mono text-[9px]'}>
```

**Файлы с наибольшим числом нарушений (по приоритету):**

| Файл | Нарушений | Действие |
|------|-----------|---------|
| `active-call-overlay.tsx` | 10+ | Добавить `const isMd3 = useThemeStore(...)`, scoped classes |
| `chat-terminal.tsx` | ~30 | Уже частично scoped — доаудит |
| `settings-modal.tsx` | ~15 | Shell-scoped typography |
| `identity-modal.tsx` | ~8 | Shell-scoped |

#### S2-3: Token documentation

Задокументировать все design tokens в `docs/design/TOKENS.md`:

```
Token              MD3 value          Terminal value
─────────────────────────────────────────────────────
--font-primary     Google Sans        JetBrains Mono
--radius-bubble    18px               0px
--radius-card      12px               0px
--surface-1        var(--md3-surface) var(--void)
--border-strong    rgba(...)          var(--neon-cyan)/20
```

#### S2-4: Dual-shell smoke test protocol

После каждого UI commit проверять по чеклисту:
- [ ] Login page — MD3 и Terminal
- [ ] Chat bubble (mine + peer) — оба шелла
- [ ] Chat input composer — оба шелла  
- [ ] Settings modal — оба шелла
- [ ] Call overlay — оба шелла

---

## Порядок выполнения

```
Priority  Task     Blocker    ETA
────────────────────────────────────────────────────────────
P0        S1-1     —          немедленно (файлы обрезаны!)
P0        S1-3     —          немедленно (UX blocker)
P1        S1-2     S1-1       после S1-1
P1        S1-4     S1-1       после S1-1
P1        S1-5     S1-1       после S1-1
P2        S2-1     —          параллельно с S1
P2        S2-2     S2-1       после S2-1
P3        S2-3     S2-2       после S2-2
P3        S2-4     S2-1       после S2-1
```

---

## Что НЕ трогать

- `server/src/lib/burn-at.ts` — `purgeExpiredBurnMessages` + `parseOptionalBurnAt` остаются; добавляем только `burn_duration_secs` path
- Vault crypto primitives (`argon2id`, `wrapPrivateJwkWithPin`) — корректны, не трогать
- WebRTC/LiveKit/E2EE path — не входит в scope этого плана
- Double Ratchet — не входит в scope

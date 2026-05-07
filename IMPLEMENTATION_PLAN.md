# OneToThree — Implementation Plan
_Generated: 2026-05-07_

## Status summary

| Area | Status |
|------|--------|
| Fan-out ECDH (C-02 HKDF) | ✅ Done |
| Vault key zero on logout (C-03) | ✅ Done |
| PIN bytes zero in WebAuthn (H-03) | ✅ Done |
| Hex branch removed from sig decode (H-04) | ✅ Done |
| Trust-store check before fan-out decrypt (M-04) | ✅ Done |
| TOTP step-up (SRV-01/02) | ✅ Done |
| Server hardening (SRV-03–09) | ✅ Done |
| Device management (DEV-01–04) | ✅ Done |
| PWA fixes (PWA-03/04/11) | ✅ Done |
| E2EE indicators UI (UI-01/02) | ✅ Done |
| Format toolbar | ✅ Done |
| Mobile bottom nav | ✅ Done |
| Chat archive | ✅ Done |
| Screen sharing | ✅ Already implemented |
| **LiveKit E2EE console.log leak** | 🔴 P0 |
| **unsafe-inline CSP** | 🔴 P0 |
| **Message editing (server PATCH)** | 🔴 P1 |
| **@mentions autocomplete** | 🔴 P1 |
| **Message drafts** | 🔴 P1 |
| **Spoiler text** | 🟡 P1 |
| Voice waveform (real AudioContext) | 🟡 P2 |
| Lottie/TGS sticker rendering | 🟡 P2 |
| Polls | 🟠 P3 |
| Channels full UI | 🟠 P3 |
| DR send path v2 | 🟠 P3 |

---

## Group A — Security (P0, implement immediately in parallel)

### A1: Remove console.log from livekit-e2ee-worker.js
**File**: `client/public/livekit-e2ee-worker.js`  
**What**: The minified worker has `console.log("encrypted payload",{original:r.payload,encrypted:s,iv:c})` inside the `encryptDataRequest` case. This leaks IV and ciphertext to DevTools.  
**Fix**: Remove the single `console.log(...)` call from the minified source.  
**Risk**: Low — the line is isolated and the rest of the function is untouched.

### A2: Remove unsafe-inline from CSP
**File**: `server/src/app.ts` lines 205-206  
**What**: Both `scriptSrc` and `styleSrc` have `'unsafe-inline'`. Next.js inline scripts need a nonce-based CSP. Tailwind inline styles need either nonce or `'unsafe-hashes'`.  
**Fix**:
- Remove `'unsafe-inline'` from `scriptSrc`; add `'nonce-${nonce}'` generated per-request via a Fastify `onRequest` hook that sets `res.locals.cspNonce` and injects it into the helmet CSP
- For `styleSrc`: keep `'unsafe-inline'` with a comment (Tailwind CDN / inline styles are unavoidable without a build-time hash step) — but remove from `scriptSrc` which is the critical one
- Update `app-security.test.ts` to match new directive

---

## Group B — Core UX (P1, next batch in parallel)

### B1: Message editing — server PATCH route
**Files**:
- `server/src/routes/messages.ts` — add `PATCH /api/messages/:messageId`
- `client/src/lib/api/messages.ts` — add `patchMessage()`
- `client/src/components/chat/message-actions.tsx` — un-hide edit button
- `client/src/components/chat/chat-input.tsx` — wire `submitEdit` to API

**What the endpoint does**:
- Verify auth + chat membership
- For DIRECT chats: accept new `ciphertexts[]` (re-encrypted per device), update `message_deliveries` rows
- For SECTOR (group) chats: accept `content` + `iv` (re-encrypted with group key)
- For PUBLIC chats: accept `content` plaintext
- Set `messages.editedAt = now()`
- Broadcast `message:edited` WS event to chat members

**Client flow**:
- `submitEdit(id, newText)` → re-encrypt with same crypto context → `PATCH /api/messages/:id`
- WS handler adds `editedAt` + new plaintext to store

### B2: @mentions autocomplete
**Files**:
- `client/src/components/chat/mentions-popover.tsx` — new component
- `client/src/components/chat/chat-input.tsx` — integrate trigger + selection

**What**:
- On `@` keypress, open a floating popover above composer
- Filter chat members by typed query (case-insensitive display name match)
- Arrow keys + Enter select, Escape closes
- Inserts `@username ` into composer text
- Server: mention counts already tracked in `unreadByChat`; no server change needed for basic autocomplete

### B3: Message drafts
**Files**:
- `client/src/lib/chat-drafts.ts` — new module (localStorage `p13_draft_{chatId}`, debounced save)
- `client/src/components/chat/chat-input.tsx` — load draft on mount, save on every keystroke, clear on send

**What**:
- Per-chat draft stored in `localStorage` under key `p13_draft_${chatId}`
- Restored when user switches back to a chat
- Sidebar shows pencil icon on chats with pending drafts
- Cleared on successful send

### B4: Spoiler text
**Files**:
- `client/src/lib/markdown.ts` (or wherever markdown is processed) — add `||spoiler||` syntax
- `client/src/components/chat/noir-plaintext.tsx` — render `<span class="p13-spoiler">` that reveals on click

**What**:
- Syntax: `||hidden text||` renders as blurred/blacked-out text
- Click to reveal (toggle CSS class)
- Both MD3 and terminal shells need styles

---

## Group C — Media (P2)

### C1: Real audio waveform for voice messages
**Files**:
- `client/src/components/chat/secure-audio-player.tsx` — add waveform visualization
- `client/src/components/chat/chat-input.tsx` — add live recording waveform via `AnalyserNode`

**What**:
- Recording: `MediaRecorder` + `AnalyserNode` → sample `getByteFrequencyData()` every 100ms → store bar heights → render animated bars
- Playback: decode audio with `AudioContext.decodeAudioData()` → extract peak amplitudes per time slice → render static waveform SVG with scrub position indicator
- Replace the current fake random bars with real data

### C2: Lottie/TGS animated sticker rendering
**Files**:
- `client/src/components/chat/sticker-bubble.tsx` — add Lottie player
- `client/package.json` — add `@lottie-files/lottie-player` or use `<canvas>` + `rlottie-wasm`

**What**:
- `.tgs` files are gzipped Lottie JSON — decompress with `DecompressionStream` (or `fflate`) → feed to Lottie player
- `static` type: render as `<img>`
- `webm` type: render as `<video autoplay loop muted playsinline>`
- `lottie/tgs` type: render as `<lottie-player>` or canvas via rlottie-wasm

---

## Group D — New features (P3)

### D1: Polls
**What**: Telegram-style polls — single/multiple choice, anonymous or not, vote counts, "Voted" state.

**Server**:
- DB: `polls` table (`id, chat_id, message_id, question, options jsonb, allow_multiple, is_anonymous, created_at`), `poll_votes` table (`poll_id, user_id, option_index, voted_at`)
- Migration: `npm run db:generate`
- Routes in `server/src/routes/messages.ts`:
  - `POST /api/polls` — create poll + attach to message
  - `POST /api/polls/:pollId/vote` — cast/change vote
  - `GET /api/polls/:pollId` — get current results

**Client**:
- `client/src/components/chat/poll-bubble.tsx` — renders question + options + vote bars + total count
- Composer button to create poll (modal with question + options)
- WS broadcast `poll:updated` on each vote

### D2: Channels full UI
**What**: Schema + server routes exist. Need client pages for creation, subscription, posting.

**Files**:
- `client/src/app/channels/` — channel discovery/browse page
- `client/src/components/chat/create-channel-modal.tsx` — creation flow (name, description, public/private, username)
- Channel chat view: show subscriber count, restrict compose to editors/owners (already enforced server-side)
- Sidebar: show channels section with subscriber-only badge

### D3: Double Ratchet send path (v2)
**What**: Currently only decrypt path uses DR v2. The send path still uses v1 fan-out.

**Files**:
- `client/src/lib/chat-crypto.ts` — `encryptOutboundTextV2()` fully wired
- `client/src/hooks/use-send-message.ts` — when `NEXT_PUBLIC_DR_ENABLED` and session exists, use v2 path
- `client/src/lib/ratchet/session-manager.ts` — `encryptForPeer()` already exists, needs integration

**Gate**: Behind `NEXT_PUBLIC_DR_ENABLED=1` flag. Default: off.

---

## Execution order

```
Batch 1 (now, parallel):    A1 + A2 (security)
Batch 2 (after A):          B1 + B2 + B3 + B4 (core UX, all independent)
Batch 3 (after B):          C1 + C2 (media)
Batch 4 (after C):          D1 + D2 + D3 (features)
```

After each batch: `git add -A && git commit && git push`, then deploy.

# Deep audit backlog — 2026-06-24 (second pass)

Source: deep multi-dimension sweep (perf, security-concept, exhaustive UI, calls,
native-runtime, infra) — 74 agents, **34 confirmed** findings (+2 uncertain),
each adversarially verified. Distinct from the N1-N22 line-bug backlog: this pass
targeted depth on performance, the E2EE/trust **concept**, every button/flow,
call logic, and why the **native apps didn't build/work**.

`D#` = this backlog. Status set inline as fixed.

---

## CRITICAL

### D1. Tauri desktop login fully broken — `X-Native-Client` missing from CORS `allowedHeaders` — FIXED
- **file:** `server/src/app.ts:291-300`
- The native fetch sets `X-Native-Client: 1` on every request; Tauri's WebView enforces CORS and preflights this custom header; the server's explicit `allowedHeaders` omitted it → every auth call CORS-blocked → desktop login impossible. (Capacitor escapes only via CapacitorHttp.) **Fixed:** added `'X-Native-Client'` to `allowedHeaders`.

### D2. SECTOR group key unwrapped from an unauthenticated, admin/server-substitutable wrap → full group MITM — **[SESSION/chip]**
- **file:** `client/src/lib/chat-logic.ts:197-228` + `server/src/routes/chats.ts:1405-1432`
- `unwrapGroupKeyFromStoredPayload` derives the KEK from `creatorEcdhPublicKeyJwk`/`ephemeralPublicKeyJwk` read verbatim from the stored blob, with NO signature and NO check it's the owner's identity (`assertTrustOrThrow` never runs for SECTOR). The wrapped-key PUT admits `role==='admin'` (not just owner) and stores verbatim. An admin or the server can overwrite a victim's wrap with an attacker key; the victim adopts it → read + inject group traffic, no UI signal. **Large crypto fix:** bind the wrap to the owner's pinned identity (verify creator key == owner ecdh key + owner signature), owner-only PUT, key-change UI warning.

---

## HIGH

### D3. Trust pin (`setVerifiedHash`) protects only the legacy static ECDH key — DR v2 never uses it — **[SESSION/chip]**
- **file:** `client/src/lib/chat-crypto.ts:56-87, 266-303`
- DIRECT is DR-v2-only (per-device DR identity). The pin/safety-number certifies the user-level static ECDH key, which the DR send/receive path never consumes; `assertTrustOrThrow` compares that unused key. Verifying a peer gives a false sense of security — a server-introduced new attacker device still MITMs with no trust violation. **Fix:** gate DR send/receive on a verified DR identity; unify the two TOFU stores.

### D4. X3DH identity-exchange (X25519) key never signed by the Ed25519 identity key — signing key anchors nothing — **[SESSION/chip]**
- **file:** `client/src/lib/ratchet/x3dh.ts:77-83, 128-144`
- `verifyBundleSignature` covers only the signed pre-key; `identityExchange` (used in DH and certified by the safety number) is used directly with no signature binding it to `identitySigning`. The server stores signing/exchange keys as independent fields. Trust collapses to bare TOFU on an unsigned, server-supplied key. **Fix:** sign `exchange_public_key` (+device_id+gen) with the identity key, publish + verify before any DH.

### D5. Read receipts rebuild & re-sort the whole message list and break `MessageRow` memoization on every scrolled-in message — FIXED-pending
- **file:** `client/src/components/chat/chat-terminal.tsx:339-353` + `store/unreadStore.ts:153`
- `updateReadAtOverride` mints a new `readAtOverrides` object per receipt; `renderMessages` re-sorts and `.map(m => ({...m}))` mints a NEW identity for EVERY message → all `memo`'d rows re-render; `groupedMessages`/`senderIdsToResolve`/voice indexes recompute. Burst on opening a chat with many unread. **Fix:** pass a narrow per-row `readAtOverride` prop (keep `message` identity stable) or look it up in-row; batch the override writes.

### D6. Armed burn timer silently ignored for ALL media (photo/voice/video/album/GIF/sticker) — FIXED-pending
- **file:** `client/src/components/chat/chat-input.tsx` (text path passes burn; media paths don't)
- `burn_duration_secs` is threaded only to `sendText`; `sendMedia`/`sendAlbum`/`sendGif`/`sendSticker` (+ `TransmitOptions`) never carry it. User arms "burn", sends a sensitive photo, gets a permanent photo — false ephemerality. **Fix:** thread `burn_duration_secs` through the media send options, or disable burn while media is queued + relabel.

### D7. "Delete account" button never deletes the account — only a local wipe — FIXED-pending
- **file:** `client/src/components/settings-modal.tsx:1324` + `client/src/lib/client-wipe.ts`
- The kill-switch UI promises permanent account deletion but `nuclearWipeClient` only `DELETE /users/me/sessions` + local wipe; `DELETE /me/account` exists server-side but the client never calls it. Account, public key, discoverability survive. **Fix:** call `DELETE /api/users/me/account` (after the PIN gate) then wipe; or relabel to "Wipe this device".

---

## MEDIUM (perf / calls / ui / infra)

- **D8** [perf] Group-chat sender lookup refetches on every read receipt (`chat-terminal.tsx:366-395`) — `senderIdsToResolve` new identity → effect re-runs `setSenderMeta({})` + `lookupUsers`. Fix: memoize on a sorted-id key; merge don't reset. — FIXED-pending
- **D9** [perf] `livekit-client` statically in the main chat bundle for every user (`livekit-call-manager.ts:17`). Fix: `await import()` it inside the gated join path. — chip/session
- **D10** [perf] Media bubbles presign on every cache HIT just to probe eviction (`media-bubble.tsx:197-213`). Fix: defer the probe to explicit restore or coalesce. — FIXED-pending
- **D11** [perf] `maybeAutoMigrateDevice` runs `COUNT(devices)` on every authenticated request forever (`auth-user.ts:186` + `device-auto-migrate.ts`). Fix: cache "has devices" / only call from login. — FIXED-pending
- **D12** [perf] `verifySessionJwt` runs 2-3× per request (`messages.ts:596,622,623`), each an extra Redis denylist round-trip. Fix: verify once per request, attach to req. — chip/session
- **D13** [perf-server] `GET /chats` runs 4 sequential queries; last 3 parallelizable (`chats.ts:268-345`). Fix: Promise.all. — FIXED-pending (low)
- **D14** [calls] Relay audio frame → 3 DB queries/frame (`ws.ts:404-450`); ~60-70 q/s per relay call + amplification. Fix: cache (sender,target) authz for the session. — chip/session
- **D15** [calls] Busy/second `call_invite` silently dropped — caller rings 30s, no busy signal (`use-webrtc.ts:534-561`). Fix: send `call_reject` in the busy branch (mirror DND). — FIXED-pending
- **D16** [calls] LiveKit-mode E2EE key never rotated — `call:session` deleted only on the mesh `group_call:leave`, which LiveKit-mode never sends (`call.ts` + `ws.ts:778`). Fix: rotate on real LiveKit room-empty (webhook). — chip/session
- **D17** [ui] Pin-message action has no visible surface (dead feature) (`chat-terminal.tsx` + `dock-panel.tsx`). Fix: render a pinned bar or remove the menu item + add a toast. — chip/session
- **D18** [ui] Switching UI language discards unsaved profile edits (`settings-modal.tsx:225-254`) — `t` in `loadSettingsFromApi` deps re-fires the load. Fix: drop `t` from deps / load profile once. — FIXED-pending
- **D19** [infra] WS fan-out is process-local, no Redis pub/sub → hard single-API-instance ceiling (`ws/registry.ts`). Fix: Redis pub/sub hub, or enforce single-instance. — chip/session
- **D20** [security] LiveKit token 6h but E2EE session 8h, not rotated on membership change — former member can decrypt a later call (same root as D16). — chip/session

## LOW (polish / defense-in-depth)

- **D21** [perf] WS audio-relay capture uses deprecated `ScriptProcessorNode` (main-thread PCM) (`call-audio-relay.ts:51`). Fix: AudioWorklet.
- **D22** [perf] Per-second burn-tick interval recreated on every store update (`chat-terminal.tsx:154-167`).
- **D23** [ui] `MediaLightbox` not focus-trapped, no body-scroll-lock/focus-restore (`media-lightbox.tsx`). — FIXED-pending (small)
- **D24** [ui] Sticker favorite toggle is a `<span onClick>` inside the send `<button>` (invalid nesting, not keyboard-reachable) (`composer-picker-panel.tsx:579`).
- **D25** [ui] QuickReactBar vs MessageReactions: different emoji sets, hover bar ignores recents (`message-actions.tsx:226`).
- **D26** [ui] Transfer-owner / demote fire on a single click, no confirmation (`group-chat-settings.tsx:496-499`). — FIXED-pending (trivial)
- **D27** [ui] Device-link/QR/onboarding modals lack ESC + focus trap (`settings-link-device-modal.tsx` et al).
- **D28** [ui] Recovery watchdog `'app-ready'` clear path is dead code → false "FORCE RESET" on slow idle loads (`recovery-handler.tsx:49`).
- **D29** [ui] `VaultPinGate` buttons always render `[ ... ]` brackets even in MD3/retro (`vault-pin-gate.tsx:133`). — FIXED-pending (trivial)
- **D30** [ui] Display name cannot be cleared to empty (`settings-modal.tsx:1310` — `|| undefined`). — FIXED-pending (small)
- **D31** [calls] Group-call mesh `${peerId}_purge` timer not cleared on reconnect (`group-call-manager.ts:229`). — FIXED-pending (trivial)
- **D32** [native] Android Keystore vault bridge missing → PIN re-entry every cold start (`native-keychain.ts`). — chip (already in ROADMAP Phase 2)
- **D33** [infra] Nonce-based CSP references a deleted `middleware.ts`; web script-src relies on `'unsafe-inline'` (`next.config.js:49`). — chip
- **D34** [infra] `coturn` (and `livekit`) run as root, host-network, no `cap_drop` unlike db/redis/minio (`docker-compose.prod.yml:317`). — FIXED-pending (small)
- **D35** [infra] API access log writes to a read-only FS path → silently dead under prod hardening (`api-access-log.ts:4`). — FIXED-pending (trivial)

**Uncertain (→ low/refuted):** mobile nav Calls==Contacts (documented tradeoff); native WS first-handshake always fails once (immaterial one-time cost).

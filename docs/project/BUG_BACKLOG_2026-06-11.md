# Bug backlog — generated 2026-06-11

Source: the codebase-bug-hunt workflow (see docs/project/BUG_HUNT_PROCESS.md), 27
findings, each adversarially verified. Work top-down in a commit-per-fix loop.
Mark items done as you ship them. [QUICK WIN] = safe single commit; [SESSION] =
focused/refactor session.

# OneToThree Bug-Hunt Backlog (ranked, deduplicated)

24 verified findings → **22 entries** after dedup (#13⊕#18, #9⊕#10). Ranked by verdict severity with security/data-loss/silent-corruption floated up. Each entry tagged **[QUICK WIN]** (safe, self-contained, do in a commit-per-fix loop) or **[SESSION]** (needs a focused/refactor session).

---

## CRITICAL

### C1. 2FA-pending JWT accepted as a full session cookie — complete 2FA bypass **[QUICK WIN]**
- **file:** `server/src/lib/auth-user.ts:40-59` (`verifySessionJwt`) + `:99-174` (`getAuthUser`)
- **category:** security
- **mechanism:** All token types (session / `2fa_pending` / `ws` / link) share one `JWT_SECRET` and differ only by a `scope` claim, but the cookie path never checks `scope`. A `2fa_pending` token (obtainable from `POST /auth/verify` with only the ECDSA signature, no TOTP) has `sub`+`username` and no `device_id`, so `getAuthUser` skips the device check and authenticates fully. `POST /auth/refresh` then launders it into a 24h session.
- **fix:** In `verifySessionJwt`, right after `jwt.verify(...)`, add `if ((payload as any).scope) return null`. Only scope-less session tokens (what `commitFmSessionCookie` mints) pass; `ws.ts:91` and `auth.ts:322` keep their own scope checks. Add `scope?: string` to `SessionJwtPayload` to drop the `as any`. Defense-in-depth: add explicit `aud`/`scope:'session'` and verify it.
- **effort:** trivial (one line + a type field). Fix first — highest impact, lowest risk.

### C2. POST /messages/send accepts arbitrary `media_path` — cross-chat media access **[QUICK WIN]**
- **file:** `server/src/routes/messages.ts:33` (schema) + `:222` (persist); authz at `server/src/routes/storage.ts:262-273`
- **category:** security (E2EE confidentiality-boundary break)
- **mechanism:** Send body's `media_path` has no format/ownership validation and is persisted verbatim. `/storage/download-url` authorizes purely on "a message with this `mediaPath` exists in a chat I'm a member of" — never on the chat the object was *uploaded* into. A member of chat C can plant a chat-B object key K onto a C-message; every C member can then fetch B's bytes via `download-url?filePath=K`, even after losing B access. Secondary: `chat-message-persist.ts:173-177` re-points the `attachments` row for K, hijacking LRU/eviction bookkeeping. (Bounded: K embeds a 122-bit random UUID, so attacker can only re-expose keys it has already seen.)
- **fix:** In `POST /messages/send`, after the membership check and before persist, reject when `media_path` is set and does not start with `chats/${p.chat_id}/${user.id}/` (and match `CHAT_OBJECT_KEY_RE`) → 400 `INVALID_MEDIA_PATH`. This closes both the download leak and the attachment-hijack. Optional defense-in-depth: in `download-url`/`restore-url`/`restore-complete`, also assert the chatId embedded in `filePath` equals the matched message's `chatId`.
- **effort:** small. Self-contained guard, do early.

### C3. Album items 2..N are undownloadable — `download-url` only authorizes item 0's key **[QUICK WIN]**
- **file:** `server/src/routes/storage.ts:262-277`
- **category:** api-contract (complete multi-item album break)
- **mechanism:** `transmitAlbum` stores only item 0's path as `messages.media_path`; items 1..N live in the encrypted envelope and have `attachments` rows with `messageId=null`. `download-url` authorizes solely via `WHERE messages.mediaPath = filePath`, so items ≥1 match no row → HTTP 410 FILE_EXPIRED → tile shows "FAIL" for every viewer including the sender. Aggravator: those `attachments` rows stay `messageId=null` forever and are evicted first as orphans.
- **fix:** Keep the `messages.mediaPath` check as primary; add a fallback authorizer: `SELECT FROM attachments INNER JOIN chatMembers ON attachments.chatId = chatMembers.chatId AND chatMembers.userId = user.id WHERE attachments.objectKey = filePath LIMIT 1`. Same membership gate `upload-url` already uses. (Verdict rates this "high"; I keep it in critical because it is a security-adjacent authz endpoint and a total feature break — but it is also a clean quick win.) Secondary: link album-item attachments to the message at persist time so they aren't orphan-evicted.
- **effort:** small.

---

## HIGH

### H1. Burn-after-read with a duration is never enforced — `burn_at` never computed at read time **[QUICK WIN]**
- **file:** `server/src/lib/mark-message-read.ts:85` and `:202`
- **category:** logic (broken privacy feature + data-retention)
- **mechanism:** Send stores `burn_duration_secs` and intentionally leaves `burn_at` NULL ("set at read time"), but both `markMessageReadByReader`/`markMessagesReadByReader` only `.set({ readAt })` — they never read `burnDurationSecs` or set `burnAt`. So duration-burns never start a countdown (client gates the countdown/auto-delete on a truthy `burn_at`), and the row survives until the 30-day `BURN_MAX_MS` fallback instead of the user's e.g. 10s.
- **fix:** In both functions compute `burnAt` in the same UPDATE: `burnAt: sql\`CASE WHEN ${messages.burnDurationSecs} IS NOT NULL THEN now() + (${messages.burnDurationSecs} || ' seconds')::interval ELSE ${messages.burnAt} END\``, and add `burnAt` to the `RETURNING`/result objects (and the batch path's events) so the read response/WS event carry the real value.
- **effort:** small. Self-contained, high user-visible + privacy value.

### H2. Group/channel/public unread badge inflates forever & can't be cleared **[SESSION]** (server interim is a [QUICK WIN])
- **file:** `server/src/routes/chats.ts:310-323` (root cause); client symptom `client/src/store/unreadStore.ts:129-151`, `client/src/hooks/use-chats.ts:59-65`
- **category:** logic. **(Merges findings #18 + #13 — same root cause: no real read-tracking for non-direct chats.)**
- **mechanism:** `unread_count = count(messages WHERE readAt IS NULL AND senderId != me)` runs for all chat types, but `messages.readAt` is only ever set for `direct_e2e` (read receipts are direct-only; group/channel `readAt` is permanently NULL). So group-type unread == lifetime non-self message count, monotonic, never decreases. Client `markChatRead` clears locally but `seedUnreadFromApi` re-inflates on the next `chats_updated` reload (entry was deleted → `!existing` → re-seed full stale count). Also re-inflates direct chats for messages never scrolled into view (the in-flight-receipt race of #13).
- **fix:**
  - **Interim [QUICK WIN]:** in `chats.ts`, restrict the `readAt`-based query to `direct_e2e` chat ids and return `unread_count: 0` for group types — stops the inflation immediately (few lines; `isGroupType` already exists).
  - **Proper [SESSION]:** add a per-member `last_read_at` cursor on `chatMembers`, updated on chat open/scroll; compute group unread as `count(messages WHERE createdAt > member.lastReadAt AND senderId != me)`. Client side: add a persisted `readFloorAt[chatId]` in `markChatRead` and have `seedUnreadFromApi` skip/clamp reseeding when no message is newer than the floor (anchor on `last_message_at`, already on `ApiChatRow`). Note: the candidate's "join `message_deliveries.delivered_at`" idea tracks *delivery* not *read* and would not clear the badge — use the read cursor.
- **effort:** interim trivial/small; proper medium. Ship the interim patch in the loop, then schedule the cursor work.

### H3. encryptForPeer silently self-fans-out when peer has no DR identity but sender has 2+ devices **[SESSION]**
- **file:** `client/src/lib/ratchet/session-manager.ts:662-679`
- **category:** correctness — **silent message loss in E2EE** (floated up per your data-loss rule)
- **mechanism:** Fan-out targets = peer's DR device identities (`fetchDeviceIdentities`, `/keys/devices/:id`) + sender's own other devices. Only emptiness guard is `uniqueTargets.length === 0`. If the peer published an ECDH key but no DR bundle (`peerDevices === []`) and the sender has a 2nd linked device, `uniqueTargets` is non-empty but contains *only the sender's own device(s)* → send reports success, peer receives nothing. Amplified by a list mismatch: the safety gate `getDrFanoutSafety` reads `fetchUserDevices` (`/users/:id/devices`, ECDH table) — a *different* list — so it passes `safe:true` for a DR-unreachable peer.
- **fix:** Load-bearing — in `encryptForPeer`, after de-dup add: `if (peerId !== ownerId && !uniqueTargets.some(t => t.userId === peerId)) throw new Error('RATCHET_NO_SESSION')` so the DIRECT send fails closed (caller shows SEND FAILED) per the "DR only, no silent downgrade" contract. Defense-in-depth: align `getDrFanoutSafety` (`fanout-crypto.ts:238-266`) to query `fetchDeviceIdentities` so the gate and fan-out agree.
- **effort:** medium. The guard itself is small, but it touches the crypto send path and fan-out/gate alignment — verify carefully (multi-device + Saved-Messages `peerId===ownerId` cases) in a focused session.

### H4. Rejected/DND-rejected 1:1 call is recorded as a "missed call" **[QUICK WIN]**
- **file:** `server/src/routes/ws.ts:550-571` (`call_reject` handler)
- **category:** logic (misleading call-history corruption + duplicate `callSessions` rows)
- **mechanism:** `call_invite` sets Redis `call:active:{chat}:{caller}`. `call_reject` logs a `rejected` row but never deletes that key. The caller's client, on `call_reject`, runs `severAllLinks()` → sends `call_leave`; the server sees the still-present key and persists a spurious `call_missed` message + a second `missed` row. DND auto-reject hits the same path.
- **fix:** In the reject handler, delete the caller's active key before returning, reusing the already-computed `otherIds`: `await Promise.all(otherIds.map(id => redis.del(\`call:active:${chat_id}:${id}\`)))`. Mirrors `call_accept`. Idempotent and race-safe regardless of reject/leave ordering.
- **effort:** trivial.

### H5. Clicking an album image never opens the lightbox (id-namespace mismatch) **[SESSION]**
- **file:** `client/src/components/chat/chat-terminal.tsx:843-882`
- **category:** logic (album media not viewable full-screen at all)
- **mechanism:** `AlbumBubble` fires `onMediaClick` with `id: \`${messageId}#${idx}\``, but `collectMsg` only enumerates whole messages keyed by bare `msg.id` and never expands album items. `allMedia.findIndex(m => m.id === media.id)` returns -1 for every `#idx` id (even tile 0), the `currentIndex !== -1` guard fails, lightbox never opens.
- **fix:** In `collectMsg`, detect album envelopes (`parseAlbumEnvelope`) and push one `allMedia`/`metaMap` entry per item keyed `${msg.id}#${idx}` (carrying per-item `path/iv/wrapCt/wrapIv`); `return` before the single-media branch to avoid a duplicate bare-id entry. Then extend `handleLightboxLoadMedia` to decrypt album items with the per-item wrapped key (mirror `album-bubble.tsx:106-117`). Keep the id format identical to AlbumBubble's cache key so decrypted tiles open instantly.
- **effort:** medium. Touches collect + metaMap type + lightbox decrypt; do alongside C3/M-albums in a media-focused session.

---

## MEDIUM

### M1. Editing a group/public message broadcasts ciphertext rendered as plaintext **[QUICK WIN]**
- **file:** `server/src/routes/messages.ts:842-850` (broadcast) + `client/src/hooks/use-chat-realtime.ts:86-101` (handler, has the `// TODO: decrypt` already)
- **category:** api-contract
- **mechanism:** `message_edited` broadcasts raw `content` (group/public ciphertext); the client stores it verbatim as plaintext via `updateMessagePlaintext`, never using the included `iv`. Every other online member sees the base64 blob until they reload.
- **fix (recommended, client-side):** add `iv` to the `message_edited` socket type (`socket.ts:84-90` — server already sends it), then in the handler decrypt via the chat crypto context (`decryptInboundText(privateKey, frame, msg.content, msg.iv)`) before `updateMessagePlaintext`. (The pure server-side "drop content" option leaves stale text because the else-branch doesn't re-fetch.) The "reject content on direct_e2e" suggestion is separate hardening, not part of this bug.
- **effort:** small.

### M2. PUBLIC-mode albums always render "signal lost" **[QUICK WIN]**
- **file:** `client/src/components/chat/album-bubble.tsx:79-152`
- **category:** logic (public-chat albums never display)
- **mechanism:** `transmitAlbum` emits public items with `iv:'public'`, `wrapCt:''`, `wrapIv:''`, but `AlbumBubble` has no public branch: it early-returns / renders "signal lost" when `!sharedKey` (always null in PUBLIC), and would otherwise `decryptBinary` an empty `wrapCt` and throw.
- **fix:** Mirror `media-bubble.tsx`'s `isPublicMedia` branch per item: gate on `item.iv === 'public'`; relax the `sharedKey` requirement for public items (`if (item.iv !== 'public' && !sharedKey) return`); fetch and use `res.arrayBuffer()` directly without unwrapping. Adjust the render gate to only bail when a *non-public* item lacks the key.
- **effort:** small. Do with C3/H5 in the media session, but standalone-safe.

### M3. Offline-queued `pending-<outboxId>` placeholder never reconciled — stuck spinner / duplicate **[QUICK WIN]**
- **file:** `client/src/hooks/use-send-message.ts:199-221` (also `use-send-media.ts:446,609`)
- **category:** logic
- **mechanism:** On network failure the hook appends an optimistic row `id:'pending-'+outboxId, _pending:true`. `flushOutboxPending` re-POSTs and only calls `removeOutboxEntry` — never touches the store. The real message arrives via WS with the real id; nothing matches/removes the placeholder. DIRECT/SELF → stuck spinner forever; SECTOR/PUBLIC → a true permanent duplicate. Clears only on full reload.
- **fix:** Bridge `outboxId → serverId`: on successful flush dispatch a `CustomEvent` with `{outboxId, serverId}`; a store action does `removeMessage('pending-'+outboxId)`. Simpler alternative: in `appendMessage` (or each real-row append site) also drop any `pending-`-prefixed row matching `(chat_id, sender_id, plaintext)`. Apply identically to the two media-hook sites.
- **effort:** small.

### M4. ICE candidates trickled before callee accepts a 1:1 call are dropped, not queued **[QUICK WIN]**
- **file:** `client/src/hooks/use-webrtc.ts:674-680`
- **category:** race-condition
- **mechanism:** The queue-push `else` branch is nested inside the `&& pc` guard. For the callee no pc exists until `acceptLink`, so every candidate trickled during the human-decision window is neither added nor queued; `flushIceQueue` on accept replays an empty queue. On relay-only restrictive NAT (only path was the early TURN candidate) the call can fail/stall. Group path queues correctly.
- **fix:** Drop the `&& pc` short-circuit and always queue keyed by `fromUserId`:
  ```
  const pc = pcsRef.current.get(fromUserId)
  if (data.kind === 'ice' && data.candidate) {
    if (pc?.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
    else (pendingIceRef.current[fromUserId] ??= []).push(data.candidate)
  }
  ```
  Refinement: add `delete pendingIceRef.current[peerId]` in `rejectLink`.
- **effort:** small.

### M5. 1:1 renegotiation offer glare is unhandled → unhandled rejection, video fails to appear **[SESSION]**
- **file:** `client/src/hooks/use-webrtc.ts:682-688`
- **category:** race-condition
- **mechanism:** The existing-pc 1:1 offer handler does `setRemoteDescription({type:'offer'})` with no `signalingState` check and no try/catch. If both peers enable camera within ~1 RTT, both are in `have-local-offer` and reject on the incoming offer; because the WS listener is async invoked from a sync try/catch, it surfaces as an unhandled rejection and the simultaneously-added video never negotiates. Group path is wrapped.
- **fix:** Implement perfect-negotiation: pick a polite peer deterministically (`polite = userId < fromUserId`), track "making offer" via `onnegotiationneeded`; on collision the impolite peer ignores the incoming offer, the polite peer `setLocalDescription({type:'rollback'})` then applies the remote offer. Minimum bar: wrap the handler in try/catch (stops the unhandled rejection) — but that alone leaves video unnegotiated, so do the full rollback.
- **effort:** medium. WebRTC state-machine correctness; focused session.

### M6. Screen-share audio track + RTP senders leaked on in-app "stop share" (1:1 and group) **[QUICK WIN]**
- **file:** `client/src/hooks/use-webrtc.ts:259-279` (`revertToOptics`) **and** `client/src/lib/group-call-manager.ts:873-899` (`stopGroupCallScreenShare`/`cleanupAll`). **(Merges findings #9 + #10 — same pattern, two call sites; fix both.)**
- **category:** resource-leak / privacy
- **mechanism:** The screen *audio* track is added to peers via `addTrack` but only cleaned up in the `screenVideoTrack.onended` handler (browser-native "Stop sharing"). The in-app stop path nulls `onended` and stops only the *video* track, so captured tab/system audio keeps streaming to all peers until the call ends — the user believes sharing stopped. No ref tracks the audio track. `cleanupAll`/leave also leaks the live track/AudioContext source.
- **fix:** Track the audio track in a ref (`screenAudioFeedRef` / module-level `groupScreenAudioTrack`), set on start. In the stop path (and `cleanupAll`): find each pc's sender by **identity** (`s.track === screenAudio`, *not* `kind==='audio'` — mic must survive), `pc.removeTrack(sender)`, then `.stop()` and null the ref. `removeTrack` triggers renegotiation, already handled by the existing screen-share flow.
- **effort:** small. One coherent fix across both files; commit together.

### M7. DELETE /me/account cascade hard-deletes the messages it just redacted to "[deleted]" **[SESSION]**
- **file:** `server/src/routes/users.ts:984-1003`
- **category:** data-loss (silent corruption of peers' history — floated up)
- **mechanism:** Handler redacts the user's messages to `content:'[deleted]'` (intending tombstones), then `tx.delete(users)` cascades via `messages.senderId ... onDelete:'cascade'` (`schema.ts:283-285`), hard-deleting the just-redacted rows. Redaction is dead work; peers' histories gap instead of showing "[deleted]". Same for `group_messages`.
- **fix:** Decide semantics. **Tombstones (matches intent):** change `messages.senderId`/`group_messages.senderId` FK to `ON DELETE SET NULL` (make `senderId` nullable) via a new drizzle migration, or re-point to a sentinel deleted-user id before deleting the user; then ensure the list-mapping tolerates null sender. **Full delete:** drop the redaction UPDATE at `:984`, keep only the mediaPath SELECT for S3 cleanup.
- **effort:** medium. Schema/migration + nullability ripple; not a one-liner. Dedicated session.

### M8. Default GET /messages/:chatId returns the OLDEST 500 — hides recent conversation **[QUICK WIN]**
- **file:** `server/src/routes/messages.ts:586,640-641`
- **category:** logic
- **mechanism:** With no `before` cursor, the query is `asc(createdAt) limit 500` → 500 *oldest* rows. Client initial load fetches with no params and `setMessages(out)` overwrites cache, so any chat with >500 messages opens to ancient history with the latest missing.
- **fix:** Always `orderBy(desc(messages.createdAt))` then always `rows.reverse()` for the no-cursor case (mirrors the existing `before` branch); fetches newest 500 in oldest→newest order. No client change.
- **effort:** trivial.

### M9. Live message dropped when a pending-pull is already in flight **[QUICK WIN]**
- **file:** `client/src/hooks/use-chat-realtime.ts:202-230`
- **category:** race-condition (liveness; self-heals on reopen/reconnect)
- **mechanism:** Fan-out WS events (null content) trigger a pending-pull guarded by boolean `pendingPullRef`. A second event during an in-flight pull returns early; if its delivery row committed after the first pull's snapshot, it's never fetched and there's no post-pull recheck, so it stays invisible until the next event/reopen.
- **fix:** Replace the boolean short-circuit with a coalescing re-pull: when a pull is requested mid-flight set `pendingPullAgainRef=true`; in `finally`, **loop** while that flag is set, re-running the (extracted) pull body before clearing `pendingPullRef`. Loop (not single re-run) to catch a third message during the second pull.
- **effort:** small.

### M10. Biometric enrollment overwrites the PIN-wrapped vault — PIN fallback lost **[QUICK WIN, but currently dead code]**
- **file:** `client/src/lib/webauthn-vault.ts:160`
- **category:** data-loss footgun
- **mechanism:** `bindBiometricAuthority` re-wraps the vault under a random `ephemeralPin` and `persistVaultBlob` *overwrites* the single stable localStorage slot, so the real PIN can no longer unwrap it; only the authenticator largeBlob can. If the largeBlob is lost, the local vault is undecryptable (no server backup). Currently mitigated only because the enrollment UI is dead-coded (unreachable in shipped UI) and a login-slot PIN copy exists.
- **fix:** Write `bioContainer` to a separate slot (`p13:vault:bio:${nodeId}`) instead of `persistVaultBlob`, and have `interceptBiometricSignal` read that slot, leaving the canonical PIN-wrapped stable slot intact. Add the bio slot to the logout/`deleteWebAuthnMetaDb` wipe.
- **effort:** small. Low urgency (path is dead-coded) but fix before biometrics is ever re-enabled — flag so it isn't shipped broken.

---

## LOW

### L1. PATCH /me/devices/:id/master can promote a revoked device to master **[QUICK WIN]**
- **file:** `server/src/routes/users.ts:648-658`
- **category:** logic
- **mechanism:** The promotion handler's existence check filters on `(id, userId)` with no `isNull(revokedAt)` guard, so a revoked device becomes master — then it can't be revoked/reauthorized (both block master). Self-recoverable (promote an active device, which demotes the ghost), so low.
- **fix:** Select `revokedAt` and, after the 404 check, `if (existingDevice.revokedAt) return reply.status(409).send({ error: 'CANNOT_PROMOTE_REVOKED_DEVICE' })`.
- **effort:** trivial.

### L2. Poll creation runs 3 non-atomic statements despite "transaction" comment — orphan polls **[QUICK WIN]**
- **file:** `server/src/routes/polls.ts:107-137`
- **category:** correctness
- **mechanism:** Comment says "in a transaction" but three separate `db` awaits (insert poll / insert sentinel message / update `polls.messageId`) auto-commit individually. A failure/crash between them leaves a `messageId=NULL` poll with no cascade cleanup — invisible in the timeline (so practically unreachable, hence low). Vote route 30 lines below already uses `db.transaction`.
- **fix:** Wrap all three writes in a single `db.transaction(async (tx) => {...})`; move the WS broadcast *after* commit so fan-out can't hold/rollback the tx.
- **effort:** trivial.

### L3. Rotation stamps keys with a possibly-stale `targetEpoch` — redundant re-key churn **[QUICK WIN]**
- **file:** `client/src/lib/group-key-rotation.ts:104-149`
- **category:** correctness (self-healing, no data loss)
- **mechanism:** `rotateGroupKeyForChat` re-fetches chat detail to enumerate members but stamps keys with the caller-passed `targetEpoch` rather than the freshly-read `detail.chat.key_epoch`. If a second departure bumped the epoch between fetches, keys are mislabeled N while wrapped for the N+1 membership → an extra full redistribution next pass.
- **fix:** After the line-110 fetch, `const epoch = detail.chat.key_epoch ?? targetEpoch` and pass `epoch` into the wrap call and the success return. Matches `deliverGroupKeyToMember`'s existing pattern.
- **effort:** trivial.

### L4. Failed-decrypt rows are acked as delivered (recovery-latency, not data loss) **[QUICK WIN]**
- **file:** `client/src/hooks/use-chat-realtime.ts:215-226`, `use-message-delivery-sync.ts:48-57`, `use-load-chat-messages.ts:124-132`
- **category:** data-loss *(downgraded by verdict to low — ciphertext slot is never deleted, ratchet isn't advanced on failure, so chat reopen recovers fully)*
- **mechanism:** All three inbound paths ack every pulled row regardless of `[DECRYPT_FAIL]`, removing transiently-failed rows from `/sync/pending`. The message is recoverable on reopen via `GET /:chatId`, but stays `[DECRYPT_FAIL]` in the live view until then (no in-session auto-retry).
- **fix:** Gate each ack on real plaintext (skip when `plaintext === '[DECRYPT_FAIL]'`, arguably also `[KEY_CHANGE_DETECTED]`) so failed rows stay pending and auto-retry. **Bound the retry** (cap re-pull attempts / ack after N failures) so a genuinely corrupt slot doesn't pin `/sync/pending` and cause repeated full-batch re-decrypts.
- **effort:** small. Note the delivery-receipt-semantics caveat — keep the retry cap in the same commit.

### L5. endCall sends `call_leave` for the wrong chat after navigating away mid-call **[QUICK WIN]**
- **file:** `client/src/hooks/use-webrtc.ts:282-289`
- **category:** logic
- **mechanism:** `severAllLinks` reads the chat to leave from `useSessionStore.getState().activeChatId` instead of the call's own chatId (never persisted). Minimize call → open another chat → End Call sends `call_leave` for the wrong chat; the real peer never gets it and must ICE-timeout. Low (peer eventually times out, no data loss).
- **fix:** Add `callChatId` + setter to `callStore`, set it in `establishLink`/`acceptLink`/`acceptAudioRelay`/`establishAudioRelay` (plumb `inc.chatId` through `acceptLink`→`acceptAudioRelay`), clear in `reset()`; use it in `severAllLinks` instead of `activeChatId`.
- **effort:** small.

### L6. Reconnect pending-pull can run the new chat's rows under the old DR context **[QUICK WIN]**
- **file:** `client/src/hooks/use-message-delivery-sync.ts:73-108`
- **category:** logic (transient, self-healing — brief `[DECRYPT_FAIL]` flash; no ratchet corruption since a failed decrypt never `saveSession`s)
- **mechanism:** Handler reads `chatId` fresh from the store but uses `cryptoCtx`/`directPeerUserId` from a stale closure (effect deps omit `activeChatId`/`directPeerUserId`). A reconnect right after a chat switch pulls the new chat's rows under the old chat's DR context → `RATCHET_NO_SESSION` → `[DECRYPT_FAIL]`, corrected on the next history decrypt.
- **fix:** Capture the chat id for which `cryptoCtx` was built and `if (chatId !== ctxChatId) return` before pulling; or add `directPeerUserId`/`activeChatId` to the effect deps and bail when `getState().activeChatId` differs. Optional hardening.
- **effort:** trivial.

### L7. Message-history keyset pagination ties on non-unique `created_at` — latent skip/dup **[QUICK WIN]**
- **file:** `server/src/routes/messages.ts:633-641`
- **category:** logic (latent — the paginated `before` branch has **no production caller** today; test-only)
- **mechanism:** Strict `<` cursor on non-unique `created_at` can skip messages sharing a boundary timestamp. The `seq` bigserial + index were added for exactly this but aren't used by pagination.
- **fix:** Composite keyset on `(created_at, seq)` (return `seq`, accept `beforeSeq`, predicate `(created_at, seq) < (beforeDate, beforeSeq)`, order `desc, desc`) — or simpler, paginate by `seq` alone (monotonic/unique). Real fix also requires a client caller to ever use this branch.
- **effort:** small. Lowest priority — purely defensive until pagination is wired up.

---

## Suggested execution order

**Commit-per-fix loop now (trivial/small, self-contained):** C1 → C2 → C3 → H1 → H4 → M8 → L1 → L2 → L3 → M2 → M1 → M3 → M4 → M6 → M9 → L5 → L6 → H2(server interim). These are independent, low-blast-radius, and each is a clean single commit.

**Dedicated focused sessions (verify-heavy / refactor / migration):**
- H3 (crypto send-path fail-closed + gate alignment — exercise multi-device + Saved-Messages)
- H5 + the media-session cluster (album lightbox decrypt; pairs naturally with C3/M2)
- M5 (WebRTC perfect-negotiation state machine)
- M7 (account-deletion FK semantics + drizzle migration + null ripple)
- H2 proper (per-member `last_read_at` read-cursor — server schema + client read-floor)

**Flag-don't-ship:** M10 (biometric vault overwrite) — fix before biometrics is re-enabled; currently dead-coded.
---

## Status — 2026-06-11 (this session)

**Fixed, tested, deployed to prod** (commit-per-fix): the QR vault-handoff and the
TOTP-step-up ECDH-gate fixes, then the full bug-hunt backlog EXCEPT M7:
C1, C2, C3, H1, H2 (server interim), H3, H4, H5, L1, L2, L3, L4, L5, L6, L7,
M1, M2, M3, M4, M5, M6, M9, M10.

**Deferred — needs a dedicated session (NOT a marathon tail):**

### M7 — account-deletion tombstones (schema migration)
`DELETE /me/account` (`users.ts:984-1007`) redacts the user's messages to
`[deleted]` and then `tx.delete(users)` cascade-HARD-deletes those same rows
(`messages.sender_id` / `group_messages.sender_id` FK `onDelete:'cascade'`), so
peers get gaps, not tombstones. Proper fix is a real migration with a wide
nullability ripple (≈53 server `senderId` sites + client decrypt-routing /
message-row rendering), so it is intentionally left for a focused session:

1. Migration: `messages.sender_id` + `group_messages.sender_id` → nullable,
   FK `onDelete: 'set null'` (drizzle generate + schema.ts:283-285, 622-624).
   Alternative without a nullable column: re-point rows to a seeded sentinel
   "[deleted] user" id before `tx.delete(users)`.
2. Keep the redaction UPDATE at `users.ts:989` (it now survives the delete).
   Note it currently only redacts the `messages` row — for DIRECT chats the
   per-device ciphertext in `message_deliveries` is NOT redacted; decide whether
   to clear those slots too.
3. Audit every `senderId`/`sender_id` reader to tolerate null: the GET
   `/messages` response mapping, `ne(messages.senderId, …)` comparisons, the
   client DR self-sync routing (`row.sender_id === drCtx.ownerUserId`), and
   message-row rendering (show null sender as "[deleted]").
4. Regression test: delete an account, assert the peer still sees `[deleted]`
   tombstones (not a gap) in both a direct and a group chat.

### H2 — proper per-member read cursor (server schema + client read-floor)
The server interim (group unread = 0) is shipped; the real feature (a
`chat_members.last_read_at` cursor so group unread actually counts/clears) is a
schema + client change for a focused session — see the H2 entry above.

# Bug backlog — generated 2026-06-24

Source: a whole-repo `codebase-bug-hunt`-style workflow (9 subsystem auditors +
adversarial verification, 38 agents). **21 findings confirmed**, 1 downgraded to
low. None duplicate the 2026-06-11 backlog (which is fully closed). Ranked by
severity with security/data-loss floated up. `[QUICK WIN]` = safe single commit;
`[SESSION]` = focused/larger.

Local gates at audit time were all green: client typecheck/lint = 0, 224 client
unit tests pass, server typecheck/lint = 0. Prod healthy; `auth` e2e passed
against prod (multi-user e2e specs are blocked by prod registration rate-limits,
an environment limit — not a product bug).

---

## HIGH

### N1. Native Bearer session JWT leaks to the S3/MinIO origin on every avatar fetch **[QUICK WIN]** — security
- **file:** `client/src/lib/api/fetch.ts:26-31`
- **mechanism:** `fetchWithTimeout` attaches the full 24h `fm_session` JWT as `Authorization: Bearer` to **every** request when `isNativeApp()`, with no destination-origin check. `avatar-cache.ts:58` and `api/avatar.ts:30` pass cross-origin **presigned MinIO URLs** (`https://s3.onetothree.ru`, ≠ `api.onetothree.ru`) into `fetchWithTimeout`, so a valid session credential is sent to the storage host (its access logs / fronting proxy / a compromised endpoint) on every avatar download and upload. The httpOnly cookie path never had this exposure (Domain-scoped, never sent to s3).
- **fix:** Origin-gate the `Authorization`/`X-Native-Client` headers to the API origin only, **or** use a bare `fetch` for the two MinIO calls (as `use-send-media.ts` already does via XHR).

### N2. Media retention purge orphans `attachments` rows + S3 bytes → permanent quota inflation **[QUICK WIN]** — resource-leak
- **file:** `server/src/lib/media-retention-purge.ts:77-105`
- **mechanism:** Purge deletes the S3 object and nulls `messages.mediaPath`, but never touches `attachments`. Rows keep `evictedAt=NULL` + non-null `sizeBytes`, so `getCurrentUsageBytes`/`getUserUsageBytes` keep counting deleted bytes forever → false `USER_QUOTA_EXCEEDED`/over-eviction. Orphan cleanup skips them (`messageId` is set). Album items 2..N (attachments-only, no `mediaPath`) are never purged at all → S3 leak.
- **fix:** In the purge, also delete / stamp `evictedAt` on the message's `attachments` rows; iterate `attachments` (not just `messages.mediaPath`) so album items 2..N are reclaimed.

### N3. Account self-deletion orphans direct chats → peer's conversation masquerades as their own "Saved Messages" **[SESSION]** — correctness/privacy
- **file:** `server/src/routes/users.ts:1099-1144` (DELETE /me/account) + `chats.ts:124-141, 341-345`
- **mechanism:** Self-delete tombstones messages then deletes the `users` row; `chatMembers.userId` cascades, but the direct chat + the peer's membership survive (unlike `adminPurgeUser`). The A↔B chat now has 1 member (B) → `isSelf` predicate is TRUE for B, and `getOrCreateSelfChat` can return it as B's "Saved Messages", intermixing private self-notes with the dead conversation.
- **fix:** In the delete transaction, delete now-single-member direct chats (mirror `adminPurgeUser`), and/or harden `isSelf`/`getOrCreateSelfChat` to require the member be the viewer **and** name = 'Saved Messages'.

### N4. Group-call mesh has no perfect-negotiation glare handling → simultaneous video-enable tears the peer down **[QUICK WIN]** — functional
- **file:** `client/src/lib/group-call-manager.ts:591-606`
- **mechanism:** `handleGroupCallOffer` does an unconditional `setRemoteDescription({type:'offer'})` with no `signalingState` check. If two peers enable camera within ~1 RTT both sit in `have-local-offer`; the incoming offer throws `InvalidStateError` → catch calls `cleanupPeer` → participant dropped. The 1:1 path (`use-webrtc.ts:708-730`) already implements polite/impolite rollback; the group manager was never given it.
- **fix:** Mirror the 1:1 logic: `polite = myUserId < fromUserId`, `offerCollision = signalingState!=='stable'`, early-return when `collision && !polite`, `setLocalDescription({type:'rollback'})` when `collision && polite`. Thread `myUserId` into `handleGroupCallOffer`.

### N5. `replyTo`/`editingMessage` persist across chat switches → reply/edit applied to the WRONG chat **[QUICK WIN]** — correctness
- **file:** `client/src/components/chat/chat-input.tsx` (store: `chatStore.ts`); composer rendered unkeyed at `chat-app.tsx:1505`
- **mechanism:** `replyTo`/`editingMessage` are global zustand state reset only by `chatStore.reset()` (logout). `setActiveChatId` never clears them and the composer isn't keyed by chat, so staging a reply/edit in chat A and switching to B sends `reply_to_id`/edits a chat-A message id into/from chat B. The **edit** case is silent (authorship-gated, no server reject).
- **fix:** Clear `replyTo`+`editingMessage` (and burn timer, see N14) on `activeChatId` change, or key the composer by `activeChatId`.

### N6. Admin purge cascade-deletes the user's group/sector messages (no tombstone) → gaps group history for everyone **[QUICK WIN]** — data-loss
- **file:** `server/src/lib/admin-purge-user.ts:133-138`
- **mechanism:** `adminPurgeUser` deletes the `users` row; `messages.senderId` has `onDelete:'cascade'`, so all the target's group/sector messages vanish for every remaining member with no `[deleted]` marker. The self-delete path deliberately re-points to `DELETED_USER_ID` to avoid exactly this; admin purge omits it.
- **fix:** Apply the same tombstone redaction (`sender_id = DELETED_USER_ID`, `content='[deleted]'`, `iv='system:v1'`, media nulled) for group/sector messages before deleting the user. Only direct-chat messages (chats wholly deleted) should disappear.

### N7. `admin_audit_log.admin_user_id` is `ON DELETE CASCADE` → deleting/purging an admin erases that admin's entire audit trail **[QUICK WIN]** — data-loss (needs migration)
- **file:** `server/src/db/schema.ts:948-950` (+ migration 0049)
- **mechanism:** The accountability record for an admin is destroyed exactly when that admin is deleted (self-delete or purged by another admin). An audit log must outlive its author.
- **fix:** `ON DELETE SET NULL` + nullable column + a new drizzle migration. `targetUserId` is already FK-less so it survives.

---

## MEDIUM

### N8. Poll-creation messages render `[DECRYPT_FAIL]` live (missing `poll:v1` sentinel in realtime) **[QUICK WIN]** — functional
- **file:** `client/src/hooks/use-chat-realtime.ts:287-302`
- **mechanism:** Poll WS event carries plaintext JSON + `iv:'poll:v1'`. The realtime branch tries to decrypt it (DIRECT → hard `[DECRYPT_FAIL]`; SECTOR → `decryptInboundText` throws), unlike the history-load path which special-cases `poll:v1`. Live the poll shows as a broken bubble until reload.
- **fix:** Short-circuit `iv==='poll:v1'` / `'system:v1'` in the realtime branch (pass content through as plaintext, mirror `apiRowToDecrypted` for kind/kindMeta). Fixes N9 too.

### N9. Missed-call system messages render `[DECRYPT_FAIL]` live (missing `system:v1` sentinel) — functional (low)
- **file:** `client/src/hooks/use-chat-realtime.ts:287-325` — **same fix as N8.**

### N10. Channel owner leaving orphans the channel — no ownership transfer, channel becomes un-manageable/un-deletable **[QUICK WIN]** — functional
- **file:** `server/src/routes/chats.ts:1049` (leave transfer gate), `1412-1440` (delete owner gate)
- **mechanism:** The owner-leave transfer branch is gated to `group_e2e || public_open`, excluding `channel`. A leaving channel owner falls through to plain-leave → channel left with members but zero `owner`. DELETE and role-promotion both require an existing owner → permanently stuck.
- **fix:** Include `'channel'` in the transfer branch; promote a successor to `role:'owner'` + `channelRole:'owner'`; delete the channel when no successor.

### N11. LiveKit group-call "E2EE" room key is derived from the server-held `LIVEKIT_API_SECRET` — the server can decrypt all call media **[SESSION]** — security (design)
- **file:** `server/src/routes/call.ts:143-145`
- **mechanism:** `call_e2ee_key = HMAC(apiSecret, "e2ee:room:session")`. The server holds `apiSecret` and the session id, so it can reconstruct every room key. This is encrypted-to-SFU, **not** E2E vs the server. (No user-facing copy claims group-call E2EE; the "E2EE" label is in code comments only.)
- **fix:** Either derive the room key from participant ECDH material (as the 1:1 path does), or stop calling it E2EE in code/docs and document the trust boundary. Large.

### N12. LiveKit call fails open to UNENCRYPTED SFU media when E2EE key/worker setup throws **[QUICK WIN]** — security
- **file:** `client/src/lib/livekit-call-manager.ts:47-61, 120-133`
- **mechanism:** `makeE2eeKeyProvider()` catches any failure, warns, returns null; `joinLiveKitCall` then builds the room **without** the e2ee block and still returns `true`, so the mesh fallback is bypassed and media flows to the SFU with no frame encryption, silently. The server always issues a key in self_hosted mode, so a key was expected.
- **fix:** When the server supplied `call_e2ee_key` but provider/worker setup fails, abort the join (return false → mesh fallback) and surface a warning. Only connect plaintext when no key was issued.

### N13. Read receipts dropped when switching chats within the 500ms batch-debounce window **[QUICK WIN]** — data-loss
- **file:** `client/src/hooks/use-read-receipts.ts:32-39, 42-52, 55-70`
- **mechanism:** The reset effect (on `activeChatId` change) clears `syncQueueRef` + the pending timer; the final-flush effect has `[]` deps so it only fires on unmount, not chat switch. Any message read <500ms before switching never has its receipt sent; local override marks it read so server `unread_count` stays stale-high.
- **fix:** Flush the queue before clearing it in the reset effect (or key the flush on `activeChatId`).

### N14. Burn-after-read timer leaks across chats → silently self-destructs messages in a different chat **[QUICK WIN]** — functional/privacy
- **file:** `client/src/components/chat/chat-input.tsx:94, 722, 1193`
- **mechanism:** `burnTimerSecs` is composer-local, set by the burn menu, never reset on chat switch (composer not keyed). Arm in chat A, switch to B → every message in B gets `burn_duration_secs`.
- **fix:** Reset `burnTimerSecs` in the `activeChatId`-change effect (do with N5).

### N15. Docker-secret files are `0600` vs the compose-documented `0644` → api reads plaintext `.env.prod` copies instead of `/run/secrets` **[SESSION]** — infra
- **file:** `scripts/generate-secrets.sh:169`, `scripts/start-unix.sh` (multiple), `sync-turn-certs.sh:168`
- **mechanism:** Compose (non-swarm) bind-mounts host secret files preserving perms; uid-1001 api can't read a `0600` root-owned file, so `readSecret` falls back to `process.env` populated from `.env.prod`, where `sync_secret_to_env` already wrote every secret in plaintext. The Docker-secrets hardening is inert and secrets are double-stored. (Confidence medium — host bind-mount semantics; secrets/ dir is 0700 so not exposed to unprivileged principals.)
- **fix:** Pick one model — either `chmod 0644` the host secret files and stop copying into `.env.prod`, or drop the secret mounts and own the env_file model.

### N16. FK onDelete drift: `groups.owner_id` & `message_threads.created_by` are `SET NULL` in the live DB but `no action` in the drizzle model **[QUICK WIN]** — infra (latent)
- **file:** `server/drizzle/0017_groups_channels.sql:21,72` vs `schema.ts:569,833`
- **mechanism:** Model and live DB disagree. If ever "corrected" to match schema, deleting a user who owns a group / created a thread would FK-violation and abort self-delete + admin purge.
- **fix:** Add `onDelete:'set null'` to both refs in `schema.ts` and regenerate the snapshot; audit other FKs for the same drift.

---

## LOW

### N17. GET `/discover` leaks `chats.invite_code` (incl. consumable one-time codes) to every authenticated user **[QUICK WIN]** — api-contract
- **file:** `server/src/routes/chats.ts:1584-1593`
- **mechanism:** Every other surface gates `invite_code` behind owner/admin; `/discover` returns it for all public_open/channel chats. A stranger can read and **burn** an owner's one-time `public_open` invite.
- **fix:** Don't return `invite_code` in `/discover`; surface only `invite_slug` / chat id.

### N18. POST `/lookup` returns username + ECDH key for any UUID with no `is_discoverable` check **[QUICK WIN, careful]** — api-contract
- **file:** `server/src/routes/users.ts:680-699`
- **mechanism:** `/search` enforces `is_discoverable` even for UUID lookup ("must be subject to the same privacy constraint"); `/lookup` (up to 64 UUIDs) does not. A non-discoverable user's handle/avatar/ECDH key is resolvable by anyone with the UUID.
- **fix (careful):** `/lookup` is the fan-out peer-key path — do **not** blanket-filter `is_discoverable` (would break sending to non-discoverable peers you share a chat with). Gate on a relationship (shared chat membership) or document the exemption. Align the two endpoints' guarantee.

### N19. `group_call:relay_frame` (+ offer/answer/ice) skip the block-check enforced on the 1:1 signaling path **[QUICK WIN]** — security
- **file:** `server/src/routes/ws.ts:899-916` vs `433-436`
- **mechanism:** 1:1 `webrtc_signal` calls `isBlocked` before forwarding; the group_call:* handlers only check room membership. In a 2-member chat-as-room a blocked user can still relay frames/signaling to the peer.
- **fix:** Add `isBlocked` before forwarding `group_call:relay_frame`/offer/answer/ice (at least for 2-participant rooms).

### N20. Hardcoded Russian UI strings bypass i18n in group/channel settings + create-group modal **[QUICK WIN]** — functional
- **file:** `client/src/components/chat/group-chat-settings.tsx:380,388`, `create-group-modal.tsx:221,236`
- **fix:** Replace literals with `t()` keys; add to locale files.

### N21. `call_e2ee_key` is stable for up to 8h and never rotated on participant leave/removal **[SESSION]** — security
- **file:** `server/src/routes/call.ts:119-145`
- **mechanism:** `callSessionId` cached in Redis with an 8h TTL, never deleted. A removed member who cached the key can passively decrypt ongoing room media for up to 8h — contradicting the in-code forward-secrecy comment.
- **fix:** Delete the `call:session:<roomId>` Redis key on last-participant-leave / member-removal so the room key rotates with membership.

### N22. Schema drift: `chats.discussion_chat_id` (migration 0033) exists in the live DB but not in `schema.ts`/snapshot **[QUICK WIN]** — infra (uncertain→low)
- **file:** `server/drizzle/0033_chats_discussion_link.sql` vs `schema.ts:194-216`
- **mechanism:** Dead, undeclared column. Prod migrate is file-based (no diff/drop), so no data-loss path in prod; only a tidy-up. `drizzle-kit push` only runs against the ephemeral predeploy DB.
- **fix:** Declare the column in `schema.ts` and regenerate the snapshot (or drop it via migration if truly dead).

---

## Suggested execution order

**Quick-win commit-per-fix loop:** N5+N14 (composer state, one fix) → N8+N9 (realtime sentinels, one fix) → N1 (Bearer origin-gate) → N6 (admin-purge tombstone) → N2 (retention purge attachments) → N4 (group-call glare) → N13 (read-receipt flush) → N12 (livekit fail-closed) → N19 (group_call block-check) → N10 (channel owner transfer) → N17 (discover invite_code) → N20 (i18n strings) → N16 (FK drift schema) → N7 (audit-log FK migration) → N3 (account-delete orphan).

**Sessions / careful:** N11 (LiveKit E2EE design — large), N15 (secret perms — operational), N18 (lookup relationship gate — don't break fan-out), N21 (call-key rotation), N22 (schema tidy-up).

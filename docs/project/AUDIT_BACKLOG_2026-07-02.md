# Audit backlog — 2026-07-02 (media / db-schema / msg-transport)

Findings from the three parallel subsystem audits. **Fixed + shipped** ones are
listed for the record; the rest are deferred here with the reason (migration or
design work, or lower severity) and the recommended fix. Verified false positives
are noted so they aren't re-reported.

## Fixed + shipped this round
- **identity_keys / device-list unbounded SELECT** — `keys.ts` GET /devices/:userId
  and `users.ts` GET /:userId/devices now `.limit(100)`.
- **SendChatMessageBody type gaps** — added `attachment_keys` + `burn_duration_secs`
  (were sent at runtime but missing from the type).
- (device-link deposit authz, ws/crypto/etc. — see other commits this session.)

## Verified NOT bugs (do not re-report)
- **DR v2 self-copy "DECRYPT_FAIL" on REST send** — `use-send-message.ts:155-162`
  already falls back to the locally-typed `content` for DIRECT/SELF when the
  self-decrypt returns empty/fail, and caches that. No stale/failed copy.
- **pendingPullRef not reset on chat switch** — the `finally` in the pending-pull
  loop resets it; the chat-switch `break` still runs it (fixed `781dfb2`).
- **cache-merge keeps cached plaintext when fresh decrypt DECRYPT_FAILs** — this is
  intentional resilience for transient DR desync; the cached plaintext is the
  real previously-decrypted message (content is key-independent), not stale/wrong.

## DB schema — RESOLVED / verified
1. **FK `messages.reply_to_id` + `group_messages.reply_to_id` + `login_events.device_id`**
   — FIXED (`bd2825c`, migration 0058, ON DELETE SET NULL, orphan-nulling +
   idempotent; verified via db:push + a clean 0000..0058 replay on a fresh DB).
2. **Poll double-vote race** — FIXED (`f63afb7`): per-(poll,user) txn advisory
   lock serializes concurrent votes; added the first polls test.
3. **`groups.invite_code` `.unique()` vs `.uniqueIndex()`** — NON-ISSUE: the
   `groups` table is legacy/unused (no inserts/reads in any route); the live path
   is `chats.invite_code`, which already uses `.uniqueIndex()`.
4. **`call_sessions.participant_ids` unbounded uuid[]** — NON-ISSUE: the write
   path (ws.ts) always inserts `[user.id]`, not client input.
5. **Negative `size_bytes` / `media_original_bytes`** — already guarded: the
   upload API validates `fileSize` with `z.number().int().positive()`, so the
   write path can't store `<= 0` (a DB CHECK would be pure defense-in-depth).

## Deferred — media/attachments quota (only active when MEDIA_QUOTA_PER_USER_BYTES set)
- **Client-declared fileSize quota bypass** (HIGH-when-enabled) — `storage.ts`
  `/upload-url` trusts the client `fileSize` for the quota check; the promised
  background reconciler does not exist, so a client can under-declare and exceed
  quota. Fix: on upload completion do a `HeadObjectCommand` to record the real S3
  size (and correct quota), or enforce Content-Length in the presigned PUT, or run
  a reconciliation job. Also a per-user quota check race (concurrent uploads read
  stale usage) — needs `SELECT ... FOR UPDATE` / txn. Quota is off by default, so
  lower urgency; do the HEAD-on-complete fix when quotas are turned on.

## Deferred — msg-transport (minor)
- **Socket send queue race** (`socket.ts`) — bounded at 200 on shift; add a
  pre-push bound + TTL for network-flap resilience.
- **Outbox retry count not persisted across reloads** (`outbox.ts`) — a reload
  resets the in-memory retry counter, so a permanently-failing entry can retry
  more than MAX_RETRIES total. Persist the count or set an absolute TTL.

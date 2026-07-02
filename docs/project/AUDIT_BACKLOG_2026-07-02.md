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

## Deferred — DB schema (need a migration; prod DB is resettable in this env)
1. **Missing FK `messages.reply_to_id` + `group_messages.reply_to_id`** (HIGH) —
   orphan reply references when the parent is deleted. Add
   `REFERENCES messages(id) ON DELETE SET NULL` via migration (null out orphans
   first, or ADD CONSTRAINT NOT VALID + VALIDATE). Client already tolerates a
   dangling reply (renders "unknown"), so this is integrity hygiene, not a crash.
2. **Missing FK `login_events.device_id` → devices(id) ON DELETE SET NULL** (MED) —
   audit-trail rows dangle when a device is revoked/purged.
3. **`groups.invite_code` uses `.unique()` while `chats.invite_code` uses
   `.uniqueIndex()`** (MED) — standardize on `.uniqueIndex()` to match the SQL and
   avoid a push-time drop/recreate divergence.
4. **`call_sessions.participant_ids` unbounded uuid[]** (MED) — validate
   `length <= 100` (or similar) in the call-session write path.
5. **Poll double-vote race** (MED) — PK `(poll_id,user_id,option_index)` allows a
   concurrent double vote across options when `allow_multiple=false`; add a partial
   unique index `(poll_id,user_id) WHERE NOT allow_multiple` or a txn guard.
6. **Negative `size_bytes` / `media_original_bytes`** (LOW) — add a `CHECK (>= 0)`
   and/or reject `<= 0` at the write path.

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

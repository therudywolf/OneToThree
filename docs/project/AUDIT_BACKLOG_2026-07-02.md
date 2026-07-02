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

## Media/attachments — investigated 2026-07-02; system is ~85% "WhatsApp-style"
The media rotation + local-storage design is already IMPLEMENTED: server LRU
eviction (`media-lru-evict.ts`) + orphan cleanup (6h cron) + 30-day retention
purge (`media-retention-purge.ts`, off-peak) + per-user/global quota + admin
evict/quota endpoints; client IndexedDB "Digital Den" cache (`media-cache.ts`),
evicted placeholder, and a restore flow that re-encrypts from the local cache.
The three media BUGS the audit flagged are ALREADY FIXED in current code:
- album download authz → `storage.ts` authorizes items 2..N via the `attachments`
  table (membership-scoped), not just `messages.media_path`.
- cross-chat media_path hijack → send path enforces `isOwnedMediaKey`
  (`chats/{chatId}/{uploaderId}/…`, + path-traversal guard).
- album eviction leak → retention purge reclaims all `attachments` linked by
  messageId, deletes their objects and stamps `evictedAt` (usage stays correct).

Remaining (deferred, low urgency):
- **Client-declared fileSize** trusted for quota + no size reconciler
  (`storage.ts:216` TODO). Dormant: MEDIA_QUOTA is OFF on prod, and global LRU
  eviction bounds disk regardless. Fix when quotas are enabled: HEAD-on-complete
  to record real S3 size, or Content-Length in the presigned PUT (verify against
  encrypted-blob sizes — breakage risk). 
- **No media evict→restore lifecycle test** (ROADMAP Phase-1 gap) — the critical
  path has no automated coverage. Highest-value remaining media work.

## msg-transport — resolved / non-issue
- **Outbox poison entry** — FIXED (`4e8296a`): 24h absolute-age drop in the flush
  loop (the in-memory retry counter resets on reload, so an age cap is needed).
- **Socket send-queue race** — NON-ISSUE: the OPEN-check and `ws.send()` are
  synchronous (no await between them) and the queue is already bounded to 200.

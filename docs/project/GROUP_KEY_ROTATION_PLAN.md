# Group Key Rotation — Implementation Plan (client-side rekey on departure)

Status: **planned, not yet implemented** · Created: 2026-05-30 · Owner decision recorded below.

## Decision (owner, 2026-05-30)

Scope chosen: **rotate the group key on member departure WITHOUT preserving history.**
After a member is kicked or leaves, the remaining members adopt a brand-new group key. Messages
sent *before* the rotation were encrypted under the old key and will **no longer decrypt** for
anyone once the new key is adopted. This is an explicitly accepted trade-off — it keeps the
implementation small (no schema migration, no message epoch-tagging, no per-epoch key history)
while delivering forward secrecy against departed members.

If history preservation is ever required, that is the larger epic: add `messages.key_epoch`,
tag each message with the epoch it was encrypted under, store wrapped keys per epoch, and keep a
client-side `epoch → groupKey` map. **Out of scope for this task.**

## Current state (verified in code 2026-05-30)

- **Server already signals rotation.** `server/src/routes/chats.ts` `rekeyGroupOnDeparture()` bumps
  `chats.key_epoch` and broadcasts a `group_key_epoch` WS event on **both** kick
  (`DELETE /:chatId/members/:userId`) and voluntary leave (`POST /:chatId/leave`, both the general
  and owner-transfer paths). Covered by `server/src/routes/chats-ops.test.ts`. Merged in PR #6.
- **Server holds no key material.** `chat_members.encrypted_group_key` is a single nullable column
  per (chat, user); there is **no epoch column** on `chat_members` and **no epoch column** on
  `messages`. `chats.key_epoch` is the only epoch counter.
- **Client only records the epoch.** `client/src/hooks/use-chats.ts` (the `group_key_epoch` handler)
  updates the chat's `key_epoch` number in local state and does nothing else — it does not
  invalidate or regenerate the group key.
- **The real group-key path** is `client/src/hooks/use-group-key-distribution.ts` using
  `wrapGroupKeyForMemberWithCreatorEcdh` / `unwrapGroupKeyFromStoredPayload` from
  `client/src/lib/chat-logic.ts`, plus `uploadMemberWrappedGroupKey` / `fetchChatDetail` from
  `client/src/lib/api/chats.ts`. `ChatCryptoContext` (`mode: 'SECTOR'`, `groupKey`) is in
  `client/src/lib/chat-crypto.ts`. This is the code to integrate with — confirm the exact group-key
  cache/installation points here before editing.

> ⚠️ Before implementing, re-verify the live group-key cache and the SECTOR `groupKey` installation
> points by reading the files above with clean tooling. (This plan was written during a session where
> local file-read tooling was intermittently corrupting output; the bullets above were captured only
> from clean reads, but a fresh confirmation pass is required before touching crypto code.)

## Implementation steps

1. **Pick a deterministic single rotator** to avoid every member racing to rekey. Recommended: the
   chat **owner**; fall back to the lowest-`user_id` remaining **admin** if the owner is the one who
   left (the owner-transfer leave path already promotes a new owner server-side, so "current owner"
   is well-defined after the membership change settles).

2. **Client `group_key_epoch` handler** (`use-chats.ts`): in addition to updating the epoch number,
   **invalidate the locally cached SECTOR group key** for that chat so the next encrypt/decrypt
   re-derives from the freshly-fetched wrapped blob.

3. **Rotator generates + distributes the new key.** On `group_key_epoch`, if this client is the
   designated rotator: fetch chat detail, generate a fresh AES-256-GCM group key, wrap it for **each
   remaining member** (ECDH from the rotator, as `wrapGroupKeyForMemberWithCreatorEcdh` already does),
   `uploadMemberWrappedGroupKey` for every member **including the rotator itself**, and install the
   new key into the local SECTOR context/cache. Make the multi-member upload resilient to partial
   failure (retry/best-effort; a missed member is recoverable by the existing
   `use-group-key-distribution` "deliver to members without keys" scan).

4. **Notify non-rotator members to refetch.** The wrapped-key upload endpoint
   (`PUT /:chatId/members/:userId/wrapped-key` in `server/src/routes/chats.ts`) currently does **not**
   broadcast. Add a `chats_updated` broadcast to the target member (or a dedicated `group_key_ready`
   event) so non-rotators reload the chat, pick up their new `encrypted_group_key`, and unwrap the new
   key. Order is naturally safe: members invalidate on `group_key_epoch`, then re-derive after the
   reload.

5. **Tests (E2EE round-trip rule — required before merge):**
   - Client unit/round-trip: generate key → wrap per member → unwrap per member → confirm a NEW key
     replaces the old, and a removed member's stored wrapped key cannot unwrap the new key. Extend the
     existing group-key distribution round-trip test style.
   - Server: assert the wrapped-key PUT broadcasts the refetch signal to the target member.
   - Confirm the accepted limitation in a test comment: messages encrypted under the prior key are not
     expected to decrypt after rotation (history-loss is intentional).

## Definition of done

On kick/leave: remaining members converge on a new group key without manual action; a departed member
can no longer decrypt messages sent after their departure; new messages decrypt for all remaining
members; round-trip tests green; the history-loss trade-off is documented at the call site.

# OneToThree — code review backlog

The 27-unit, 6-dimension review of 2026-07-25 produced 168 raw findings → 148
after dedupe → 118 that survived adversarial verification.

**All 118 have now been worked.** 109 are fixed and deployed; 9 are deliberately
carried, each for a stated reason. This file is the record of what remains.

| Round | What happened |
|-------|----------------|
| 1 | 13 fixed by hand — commits `0c18c28`, `ea0a50f`, `e83c86d`, `8d4b7cc` |
| 2 | 99 fixed by 12 parallel agents, then adversarially reviewed: 25 review findings, 5 refuted, **20 self-introduced defects repaired** — commit `5317868` |

The review round is worth remembering. One of the 99 "fixes" deleted a device's
identity key on revocation, which would have made every message still in flight
from a revoked device permanently undecryptable *and* broken existing production
rows the moment it deployed. It was caught only because the fixes were reviewed
as adversarially as the original code was.

---

## Deliberately not fixed (9)

None of these are cheap. Each needs a wire-format version, a two-sided protocol
change, or a schema migration whose blast radius is larger than the bug itself.

### Crypto

**1. Sector key wrap authenticates no metadata (no AAD)** — `client/src/lib/chat-logic.ts`
An old wrapped key can be replayed as the current epoch. The fix binds a canonical
header as AES-GCM `additionalData`, which changes what every wrap authenticates —
so it needs a `v:3` payload shipped alongside `v:2`, with `v:2` still accepted
until every deployed client has rotated. A one-sided change locks every existing
group out of its own history.

**2. Two sessions can rotate to divergent keys at the same epoch** — `client/src/hooks/use-group-key-distribution.ts`
Convergence needs a server-side compare-and-swap on `chats.key_epoch` so a second
session's rotation at the same epoch is rejected. That is a server route plus a
schema concern; the client half alone cannot make it safe. Partially mitigated on
the read side by the epoch ring.

**3. Sector MEDIA uses a single key with no epoch ring** — `client/src/hooks/use-chat-aes-key.ts`
The hook returns one `CryptoKey` that flows into `decryptBinary` at three call
sites. Returning a ring means changing all of them together; a partial change is
dead code.

**4. X3DH prekeys are derived deterministically from the static vault key** — `client/src/lib/ratchet/identity-from-vault.ts`
Confirmed real: a leaked vault retroactively recovers every archived session's
X3DH secret, so the one-time prekeys contribute no forward secrecy. Randomising
them means the prekeys must be persisted and republished, which touches the key
directory, the bundle upload and the vault backup format at once.

**5. Call relay frames carry no AAD, no sequence number, and a static key** — `client/src/hooks/use-webrtc.ts`
Binding an AAD requires new `additionalData` parameters on the shared
`encryptBytes`/`decryptBytes` in `lib/crypto.ts` — used by the message fan-out and
the group wrap — plus matching changes in `group-call-manager`. A wire-protocol
change across three subsystems.

**6. ECDH public-key publish has no vault-unlock proof** — `server/src/routes/users.ts`
`patchMyEcdhPublicKey` is called on every login and every vault unlock with no
proof, so a bare stolen session can redirect peers' fan-out encryption. The fix is
two-sided (the client must sign a server nonce with the keyring's ECDSA key);
server-only enforcement would lock out every current client.

### Backend / infra

**7. `messages.media_path` hot-path query is unindexed** — `server/src/routes/storage.ts`
`messages_media_path_idx` is keyed on `created_at` with `media_path` only in the
partial predicate, and `messages_chat_media_idx` leads with `chat_id`, which this
query does not constrain. Needs a new migration plus a `schema.ts` index
declaration. Harmless at current scale.

**8. `clearBackupPending()` has no production caller** — `client/src/lib/backup-reminder.ts`
The "you still have no way back into this account" banner is never cleared by the
two events that should clear it. The call sites live in `settings-devices-panel.tsx`
and the recovery-phrase enrollment success path — outside the owning batch's files.
Small and worth doing next.

**9. LiveKit 7880 is plaintext on all interfaces** — `docker/livekit/livekit.yaml`
The suggested fix (bind to 127.0.0.1) would take group calling down: Caddy is a
separate container in `~/infra/caddy` and reaches the SFU over the docker bridge
gateway, not loopback. The host firewall is the correct control, and `ufw`
default-deny already covers it — `docker-compose.prod.yml` now carries the
checklist next to the service.

---

## Refuted during the fix review

Reported, then knocked down on inspection. Recorded so they are not re-raised.

| Finding | Why dismissed |
|---------|----------------|
| Ring entries unwrapped with no owner binding | Every ring entry was admitted only after passing the owner binding at write time; `buildSectorFrame` is the sole writer |
| `recordFailure` EVAL vs `checkLockout` GET/TTL | Both paths degrade consistently; scripting is available on the deployed Redis |
| Redis rate-limit `skipOnError` fails open | The limiter falls back to the in-memory store rather than skipping the check |
| Direct-chat delete leaves attachments charged | The quota rows go with the chat |
| Sticker blob-URL revoked between resolve and commit | The URL is retained until the next resolution of the same sticker |

Four more were refuted only because they had already been fixed earlier in the
same session and the verifiers read the corrected code: the CSWSH origin check,
the vault key surviving logout, admin ban/purge of the creator, and coturn's
`env_file`.

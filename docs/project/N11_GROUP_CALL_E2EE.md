# N11 — True E2EE for Group Calls (design + scope)

_Status: investigated 2026-07-01, NOT implemented. This is the plan of record._

## Recommendation (2026-07-02): defer / likely won't-do for the self-hosted model
OneToThree is **self-hosted** — the operator IS the server owner, so "E2EE vs the
server" (the whole point of N11) mostly protects against a *compromise of your own
box*, not an untrusted host. Chats are already E2EE (a server breach can't read
them); 1:1 calls are already E2EE (per-peer ECDH). Group-call media on the LiveKit
SFU is SFrame-encrypted vs a passive SFU/network observer, honestly labeled as
NOT-E2EE-vs-server, and calls are ephemeral (not stored). Against that, N11 is
~2 weeks of high-risk crypto that can't be verified without a real LiveKit +
multi-browser matrix, has Firefox/WebView insertable-streams gaps, and depends on
verified participant keys (D2). Net: the marginal security gain (group-call media
surviving a full server compromise) does not justify the cost/risk right now.
**Revisit only if the threat model explicitly requires it.** Keep the honest
labeling + fail-closed already in place.

## Current state (verified against code)

Group-call media encryption depends on the transport mode:

| Path | Key derivation | Server can decrypt? | Notes |
|---|---|---|---|
| **1:1 call** | ECDH(local_priv, peer_ecdh_pub), on-device | **No** | Truly E2EE. `use-webrtc.ts`. |
| **Group — LiveKit SFU** (`CALL_MEDIA_MODE=self_hosted`, prod default) | `HMAC(LIVEKIT_API_SECRET, "e2ee:{roomId}:{sessionId}")`, server-side | **Yes** | SFrame/Insertable-Streams frame encryption, but the key is server-derivable. `server/src/routes/call.ts:190`, `client/src/lib/livekit-call-manager.ts`. |
| **Group — origin-safe WS audio relay** (`origin_safe`) | pairwise ECDH per participant pair, on-device | **No** | AES-GCM frames relayed as opaque ciphertext (`ws.ts group_call:relay_frame`). N² scale. `group-call-manager.ts:111`. |
| **Group — mesh P2P fallback** | DTLS-SRTP between peers | **No** (TURN only relays) | Used when SFU unavailable. |

So the premise "the server can decrypt group calls" is **true only for the LiveKit SFU path** — which is the production default for group calls. It is honestly documented in code (`call.ts:157-163`, `livekit-call-manager.ts:9-14`: "Do not market group calls as E2EE").

### Already done (do NOT redo)
- **Fail-closed:** if a room key was issued but the E2EE key-provider or the `/livekit-e2ee-worker.js` worker fails to start, the join **aborts** rather than connecting plaintext-to-SFU (`livekit-call-manager.ts:125-152`). No fail-open-to-plaintext path.
- **Honest labeling:** no user-facing string claims the SFU group path is E2EE; the "server cannot read content" tooltips are scoped to the origin-safe pairwise relay/P2P paths, which are genuinely E2EE.

## The gap

The LiveKit SFrame room key is derived by the server from `LIVEKIT_API_SECRET`, so the app server (and anyone with that secret) can reconstruct it and decrypt group-call media. To be E2E-vs-server, the room key must come from **participant key material the server never holds**.

## Recommended approach

Derive the SFrame room key on-device from participant ECDH material and feed it to LiveKit's `ExternalE2EEKeyProvider`, ignoring the server-issued key:

1. Before joining, fetch the current room participants' **verified** ECDH public keys.
2. `call_key = HKDF(sort+concat(participant_ecdh_pubs), info="call:e2e:{roomId}:{epoch}")`.
3. Use `call_key` for SFrame; the server still issues the LiveKit JWT for SFU **auth** but its `call_e2ee_key` is ignored.
4. **Rotate** on join/leave: recompute from the new participant set (new `epoch`) and call LiveKit's key-update API so post-change frames use the new key (forward secrecy across membership changes).

## Hard dependencies / risks

- **D2 (SECTOR key binding):** the room key is only as trustworthy as the participant ECDH keys. If the server can substitute a key, it can MITM the call key. N11 must bind derivation to **verified** member identities — same class of fix as D2. **N11 should not ship before this is addressed.**
- **Browser/WebView support for Insertable Streams / `RTCRtpScriptTransform`:** Chrome/Edge ✅, Safari ✅ (17.2+), Firefox partial, Capacitor/Tauri WebViews vary. Must keep the existing fail-closed behavior so an unsupported client falls back to mesh, never to plaintext.
- **Rotation correctness:** old key must not decrypt post-rotation frames; races on rapid join/leave.

## Verifiability (why this is not a "just ship it" change)

Local unit tests can cover key derivation (determinism, membership sensitivity) and the negative test (server HMAC key does NOT decrypt client-derived frames). But **end-to-end** verification requires a **real LiveKit SFU + ≥3 real browsers** (and the mobile WebView matrix), capturing frames and confirming the server-side HMAC key cannot decrypt them. That infra does not exist in the local e2e harness (D5 only checks `/ice-servers` shape). Per the project rule *"don't ship unverified crypto,"* N11 needs that verification harness stood up first.

## Work items (ranked)
1. `client/src/lib/call-group-key-derivation.ts` + unit tests (deterministic, membership-sensitive). _Verifiable locally._
2. Bind derivation to verified member ECDH identities (D2-class). _High risk._
3. Wire `livekit-call-manager.ts` to the client-derived key; server stops issuing / client ignores `call_e2ee_key`. _Needs real-LiveKit E2E._
4. Rotation on membership change (client recompute + LiveKit key-update; `ws.ts` join/leave events). _High risk; needs E2E._
5. Browser/WebView matrix + keep fail-closed. _Needs real devices._

**Estimate:** ~1.5–2 sprint-weeks; medium-high risk; **not** fully verifiable without new call-test infrastructure.

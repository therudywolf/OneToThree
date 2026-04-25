# OneToThree Calls And Crypto Audit
Date: 2026-04-24
Scope: 1:1 call path, audio-relay fallback, group-call path, signaling, key use, server visibility, operator claims

## 1. Executive verdict

Current call security is mixed and must be described precisely.

What is honestly true today:

- 1:1 WebRTC calls are encrypted in transit by normal browser WebRTC transport security.
- 1:1 fallback audio relay frames are encrypted client-side before they cross the WebSocket path.
- TURN is no longer mandatory for basic 1:1 voice survivability because the app now has a STUN-plus-encrypted-audio-relay fallback.

What is not honestly true today:

- It is not correct to claim that all calls are implemented with Signal-grade or Telegram Secret Chat-grade end-to-end verification.
- It is not correct to claim that group calls currently have a separate application-layer E2EE envelope.
- It is not correct to claim that the LiveKit `call_e2ee_key` path is active in runtime. The token route exists, but the client group-call runtime does not consume it.

Bottom line:

- 1:1 voice is now materially more robust.
- 1:1 audio relay is encrypted, but it does not have forward secrecy and is not identity-verified against a malicious server.
- Group calls are still plain full-mesh WebRTC from a cryptographic architecture perspective.

## 2. Implementation matrix

### 2.1 1:1 WebRTC path

Relevant files:

- `client/src/hooks/use-webrtc.ts`
- `client/src/lib/ice-servers.ts`
- `server/src/routes/webrtc.ts`
- `server/src/routes/ws.ts`

Behavior:

- Client fetches ICE config from `/api/ice-servers`.
- If Cloudflare TURN or coturn is configured, the connection is created with relay-capable ICE servers.
- The browser handles DTLS/SRTP transport encryption.

Security properties:

- Media is protected in transit against passive network observers.
- A TURN server relays encrypted SRTP packets and does not see media plaintext.
- The signaling server still sees call metadata and can relay or tamper signaling.

Gaps:

- No explicit fingerprint verification UI.
- No user-visible safety-number flow tied to calls.
- No additional application-layer media encryption on top of WebRTC.

### 2.2 1:1 audio-relay fallback

Relevant files:

- `client/src/hooks/use-webrtc.ts`
- `client/src/lib/call-audio-relay.ts`
- `client/src/lib/crypto.ts`
- `server/src/routes/ws.ts`

Behavior:

- When `/api/ice-servers` resolves without TURN, a 1:1 call falls back to audio-only relay.
- Microphone PCM is captured in the client with Web Audio.
- PCM frames are encrypted with AES-GCM and sent as opaque `relay_frame` payloads through the existing authenticated WebSocket channel.
- Receiver decrypts frames and plays them through an `AudioContext`.

Security properties:

- Server relays ciphertext and cannot read audio payloads if it only forwards frames.
- The derived AES key is non-extractable in working memory.

Gaps:

- The shared key is derived from long-lived user ECDH identity material, not a per-call ephemeral ratchet.
- There is no forward secrecy for relay-mode audio.
- There is no call-specific identity verification beyond whatever trust the client places in server-published user keys.
- A malicious server that can swap public keys or signaling can still mount a MITM against relay calls.

### 2.3 Group calls

Relevant files:

- `client/src/hooks/use-group-call.ts`
- `client/src/lib/group-call-manager.ts`
- `server/src/routes/ws.ts`
- `server/src/routes/call.ts`

Behavior:

- Group calls use full-mesh WebRTC.
- The server maintains room membership and relays offer/answer/ICE between participants.
- The current client runtime does not use `/call/token` or `call_e2ee_key`.

Security properties:

- Transport security comes from WebRTC itself on each peer connection.
- There is no implemented extra call-layer encryption envelope for group audio/video.

Gaps:

- No LiveKit/SFU runtime is wired in despite the token issuer existing.
- No insertable-stream E2EE path is active.
- No per-room application-layer group call key is consumed by the client.

## 3. Key handling and storage

Relevant files:

- `client/src/lib/crypto.ts`
- `server/src/db/schema.ts`

Observed model:

- `users.ecdh_public_key_jwk` stores a user-level ECDH public key on the server.
- The matching private key stays client-side in the local vault / IndexedDB import path.
- `deriveSharedSecret()` produces an AES-GCM key from local private key plus peer public key.
- Relay-mode audio uses `encryptBytes()` and `decryptBytes()` with that derived key.

Important limitation:

- The relay call key is tied to long-lived account identity material.
- It is not rotated per call.
- It is not ratcheted per frame.
- It is not bound to a device-specific call session.

Practical consequence:

- If the long-lived private key is compromised later, previously captured relay ciphertext could become decryptable.
- This limitation does not apply in the same way to normal WebRTC DTLS/SRTP transport, which uses ephemeral session keys inside the browser stack.

## 4. Server visibility

Server can see:

- who called whom,
- call start and leave events,
- SDP offers and answers,
- ICE candidates,
- room membership for group calls,
- whether the fallback relay mode is being used.

Server cannot directly see:

- plaintext audio payload for `relay_frame` traffic,
- plaintext SRTP media inside normal WebRTC transport.

Server can still influence:

- which public key the client fetches for a peer,
- which signaling messages arrive,
- whether a call is forced into a different path or interrupted.

## 5. Reliability assessment

### Current best-covered scenarios

- 1:1 WebRTC with working TURN.
- 1:1 WebRTC on friendly NAT with STUN.
- 1:1 audio-only fallback over standard `wss/https` when TURN is unavailable.

### Still weak scenarios

- video over hard symmetric NAT without TURN,
- group calls over weak NAT topologies,
- large group calls because runtime is still full mesh rather than SFU-backed,
- low-end mobile devices in relay mode because PCM capture/playback is CPU- and battery-heavier than codec-native RTP.

## 6. Honest claim language

Safe operator wording:

- "OneToThree encrypts message content on device."
- "1:1 calls use WebRTC encryption in transit."
- "When TURN is unavailable, 1:1 voice can fall back to encrypted audio relay over the normal HTTPS/WebSocket route."

Unsafe operator wording:

- "All calls are fully end-to-end verified."
- "Group calls have the same cryptographic guarantees as 1:1 secret calls."
- "LiveKit E2EE is already active."
- "Relay-mode calls have forward secrecy."

## 7. Findings

### High

- `client/src/hooks/use-webrtc.ts`
  - relay-mode audio uses static user ECDH material, so there is no per-call forward secrecy.

- `client/src/hooks/use-webrtc.ts`
  - relay-mode key agreement trusts server-published peer public keys without a call-specific verification step.

- `client/src/lib/group-call-manager.ts`
  - group calls do not use the `call_e2ee_key` path from `server/src/routes/call.ts`, so the extra E2EE design is not active in runtime.

### Medium

- `client/src/lib/call-audio-relay.ts`
  - fallback relay is raw PCM over WebSocket, which is simple and works, but is less bandwidth-efficient and heavier on battery than codec-native RTP.

- `server/src/routes/ws.ts`
  - signaling relay is opaque and membership-checked, which is good, but it does not authenticate SDP fingerprints at the UX layer.

- `server/src/routes/webrtc.ts`
  - `/api/ice-servers` now correctly supports STUN-only fallback, but the older `/api/turn` route still reflects the legacy "relay mandatory" assumption.

## 8. Recommended next steps

1. Add explicit call identity verification or reuse the existing trust-store UX for calls.
2. Replace static relay keying with per-call ephemeral ECDH and a ratcheted session key schedule.
3. Decide whether group calls stay full mesh or move to a real SFU path, then wire `call_e2ee_key` into the actual client runtime if LiveKit is kept.
4. Add live network test coverage for:
   - direct WebRTC,
   - TURN relay,
   - STUN-only audio relay,
   - mobile network to Wi-Fi,
   - Cloudflare-proxied signaling.
5. Document product claims using the wording in section 6 so deployment copy stays accurate.

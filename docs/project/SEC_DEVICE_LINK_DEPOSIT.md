# SEC — device-link rendezvous `/deposit` is not authorized by a secret (Mode A)

_Found 2026-07-02 during the auth/security audit. NOT yet fixed — needs protocol
design + real verification; do not one-shot it. Tracked here as the plan of record._

## The gap

`POST /api/devices/link/rendezvous/:id/deposit` (`server/src/routes/devices.ts`)
authenticates the caller but authorizes the deposit **only by knowledge of the
rendezvous id**. Unlike `submit-pubkey` and `claim`, it does **not** require the
`claim_secret`. The rendezvous id travels in the URL **path** (server/proxy logs,
browser history), while the `claim_secret` travels in request bodies / the QR — so
the id can leak without the secret.

`GET /:id/status` returns the new device's `ephemeral_pubkey` to any authenticated
caller who knows the id. So an attacker who learns a live rendezvous id can:
1. `GET /status` → read `ephemeral_pubkey`,
2. encrypt a malicious vault-handoff blob to it,
3. `POST /deposit` it (first-write-wins) before the legitimate old device.

The victim's new device then `claim`s (it has the `claim_secret`) and provisions
from the attacker's blob — i.e. the new device comes up on **attacker-controlled
keys**. Impact is device-link integrity (the victim lands on the wrong/attacker
account on that device — detectable, not a silent takeover of existing data).
Severity: **HIGH**, conditions-heavy (needs the id to leak + winning the short
first-write race within the rendezvous TTL).

## Why the obvious fix does not work

Requiring `claim_secret` on `/deposit` closes it in **Mode B** (old device created
the rendezvous, so it has the secret) but **breaks Mode A**: there the new device
creates the rendezvous and keeps the `claim_secret` to itself (by design, so a QR
photo can't claim); the Mode A QR carries only `{rendezvousId, ephemeralPubkey}`
(`client/src/lib/device-link-crypto.ts` `LinkQrPayload`). The Mode A depositor
(old device) never holds `claim_secret`, so there is no shared secret to check.

## Recommended fix (needs implementation + verification)

Introduce a **deposit token** distinct from the claim secret:
- `POST /link/rendezvous` returns `deposit_secret` in addition to `claim_secret`.
- Mode A: put `deposit_secret` (NOT `claim_secret`) into the QR the new device
  shows. The old device scans it and sends it on `/deposit`; the server checks it
  (constant-time) against a stored hash. A photographed QR can then only deposit
  (which first-write-wins + the verification-code compare already bound), never
  claim. Mode B already has both secrets on the old device.
- Keep `claim_secret` off any path; keep `/deposit` + `/status` id-in-path but
  gated by the `deposit_secret` body field.
- Verify end-to-end on the real device-link flow (both modes) before shipping —
  this is the vault-handoff path; a wrong change bricks linking.

## Interim mitigations already in place
- First-write-wins on `submit-pubkey` and `deposit` (a racing second write → 409).
- `claim` requires `claim_secret` (a QR photo alone can't retrieve the blob).
- Short rendezvous TTL (`RENDEZVOUS_TTL_S`) bounds the race window.
- Verification-code compare across both screens (does NOT catch a same-ephemeral
  malicious deposit, so it is not a substitute for the deposit token).

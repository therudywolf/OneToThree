@echo off
chcp 65001 > nul
cd /d C:\Users\rudywolf\Workspace\OneToThree
echo Removing lock file if exists...
del /f .git\index.lock 2>nul

echo Adding all changes...
git add -A

echo Committing...
git commit -m "security: full audit remediation — HKDF fanout, trust check, H-03/H-04, C-03, UI fixes, archive, mobile nav

Cryptography:
- C-02: deriveSharedSecretHkdf() ECDH bits to HKDF-SHA256 to AES-GCM (NIST SP 800-56C), v2: IV prefix for backward compat
- C-03: clearOwnDrIdentity() nullifies sessionWrapKey; logout calls clearOwnDrIdentity()
- C-04: @deprecated on deriveOtpPrivKey() in identity-from-vault.ts
- C-05: assertTrustOrThrow() documented as contract in chat-crypto.ts
- H-02: safeEqualNonce() uses constant-time padding + timingSafeEqual
- H-03: PIN bytes zeroed via fill(0) in try/finally in webauthn-vault.ts
- H-04: hex branch removed from decodeSignatureBuffer() in ecdsa-verify.ts
- M-03: normalizeJwk() applied in outbox.ts
- M-04: sender_ecdh_public_key_jwk verified against trust store before fan-out decrypt

Server:
- SRV-01: TOTP step-up on DELETE /me/account
- SRV-02: TOTP step-up on DELETE /me/sessions and /me/sessions/:id
- SRV-03: user search by UUID respects isDiscoverable=true
- SRV-04: direct chat block check uses chat type not member count
- SRV-07: 5s timeout on all sticker fetch requests
- SRV-08: IPv6 NAT64 and 6to4 ranges added to SSRF guard
- SRV-09: purgeExpiredBurnMessages() runs every 60s
- DEV-01: Redis revocation check in getAuthUser() + set on device revoke
- DEV-02: allowDeviceLinking checked in /devices/link/confirm
- DEV-03: ECDH key rotation requires TOTP step-up
- DEV-04: getMigratedClientKey(userId) prevents key collision
- PWA-03: stale FCM tokens deleted on push error

UI / UX:
- UI-01: E2EE indicators (Lock/ShieldCheck/ShieldOff) in chat headers
- UI-02: NOT ENCRYPTED banner in PUBLIC chats
- PWA-04: navigator.onLine check before call
- PWA-11: media cache limit 40MB on iOS, 512MB elsewhere
- MD3: fixed terminal style leakage in thread-panel and noir-plaintext
- A11y: focus trap in forward-modal, ARIA attributes

New components:
- format-toolbar.tsx: Bold/Italic/Code/Strikethrough with Ctrl+B/I/backtick
- mobile-bottom-nav.tsx: Chats/Contacts/Calls/Settings, 44px touch targets
- chat-archive.ts: chat archiving via localStorage with cross-tab sync"

echo Pushing to GitHub...
git push

echo.
echo Done!
pause

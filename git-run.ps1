Set-Location "C:\Users\rudywolf\Workspace\OneToThree"

# Remove lock if exists
if (Test-Path ".git\index.lock") {
    Remove-Item ".git\index.lock" -Force
}

git add -A
git commit -m "security: full audit remediation - HKDF fanout, trust check, H-03/04, C-03, UI/UX fixes

- C-02: deriveSharedSecretHkdf() ECDH->HKDF-SHA256->AES-GCM (NIST SP 800-56C), v2: IV prefix
- C-03: clearOwnDrIdentity() nullifies sessionWrapKey on logout
- H-03: PIN bytes zeroed via fill(0) in try/finally webauthn-vault.ts
- H-04: hex branch removed from decodeSignatureBuffer ecdsa-verify.ts
- M-04: sender_ecdh_public_key_jwk verified vs trust store before decrypt
- SRV-01/02: TOTP step-up on account/session delete
- SRV-03/04/07/08/09: user search, chat block, sticker timeout, SSRF, burn purge
- DEV-01/02/03/04: Redis revocation, device linking, ECDH key rotation TOTP, key collision fix
- PWA-03/04/11: FCM stale tokens, offline call guard, iOS media cache limit
- UI-01/02: E2EE indicators, NOT ENCRYPTED banner in PUBLIC chats
- MD3/A11y: shell style isolation, focus trap, ARIA
- New: format-toolbar, mobile-bottom-nav, chat-archive"

git push
Write-Host "DONE" -ForegroundColor Green

# Security audit notes (rolling)

Severity: **critical** / **high** / **medium** / **low** / **info**.

## Sessions and cookies

- **`fm_session`:** Set via [`server/src/lib/session-cookie.ts`](../server/src/lib/session-cookie.ts): `httpOnly: true`, `secure: true` in production, `sameSite` `lax` when `COOKIE_DOMAIN` is set (cross-subdomain API + web), else `strict` in production without domain.
- **Duplicate cookies:** Parser prefers **last** `fm_session` value — documented for shared-domain account switches.

## QR login

- **Generate:** [`server/src/routes/auth.ts`](../server/src/routes/auth.ts) — requires authenticated user, ECDSA signature over nonce, optional TOTP if enabled, respects `allowDeviceLinking`.
- **Consume:** `POST /api/auth/qr-login` rate-limited (`10/min` in route config), token single-use via Redis (`consumeQrLinkToken`). Expiry: `QR_LINK_TTL_S`.
- **Client:** Token passed as `link_token` query on `/auth/qr` — avoid logging full URLs in shared logs.

## Edge / reverse proxy

- **[`Caddyfile`](../Caddyfile):** HSTS, `X-Frame-Options: DENY`, nosniff, CSP (allows `unsafe-inline` for scripts/styles — **medium**: review if tightening CSP is feasible), `frame-ancestors 'none'`.
- **TURN / LiveKit:** Subdomains documented as DNS-only (gray cloud) where UDP matters.

## Follow-ups (not automatically verified here)

- Dependency advisories: `npm audit` in `client/` and `server/` on each release.
- Secrets: only via Docker secrets / env files excluded from images — verify CI does not bake `.env` with secrets into `web` build args beyond public `NEXT_PUBLIC_*`.

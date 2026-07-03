# infra/

Infrastructure helpers that live alongside the app but are not part of the
application image itself.

| Path | What it is |
| --- | --- |
| `lite/Caddyfile.example` | Documents the single-origin Caddy config the **Lite** installer generates (`scripts/lite/install.mjs`) for each mode — localhost / LAN self-signed HTTPS / domain. The real `lite/Caddyfile` is generated per-install and gitignored. See [docs/guides/LITE.md](../docs/guides/LITE.md). |
| `e2e/Caddyfile` | Same-origin reverse proxy used by the local end-to-end harness (`npm run test:e2e:local`) so the web app, REST API, and WebSocket share one origin. |
| `systemd/` | Optional host units for the **full** deployment: `onetothree-backup.{service,timer}` (scheduled encrypted backups) and `onetothree-uptime.{service,timer}` (health monitoring), plus `install.sh` to install them. See [docs/OPS.md](../docs/OPS.md). |

> The production TLS edge (Caddy + WAF) for the hosted deployment runs as a
> **separate** stack outside this repo — see the operations notes in
> [docs/OPS.md](../docs/OPS.md).

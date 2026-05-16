#!/usr/bin/env bash
# Install OneToThree systemd units (backup + uptime).
#
# Run as root:
#   sudo bash infra/systemd/install.sh
#
# Idempotent — re-running reloads the unit definitions.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/infra/systemd"
DEST="/etc/systemd/system"

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 2; }

for f in onetothree-backup.service onetothree-backup.timer \
         onetothree-uptime.service onetothree-uptime.timer; do
  install -m 0644 "$SRC/$f" "$DEST/$f"
  echo "installed $DEST/$f"
done

systemctl daemon-reload

systemctl enable --now onetothree-backup.timer
systemctl enable --now onetothree-uptime.timer

echo
echo "✓ installed."
echo
echo "Status:"
systemctl status onetothree-backup.timer --no-pager | head -8 || true
systemctl status onetothree-uptime.timer --no-pager | head -8 || true
echo
echo "Inspect logs:"
echo "  journalctl -u onetothree-backup.service -n 50"
echo "  journalctl -u onetothree-uptime.service -n 50"
echo "  systemctl list-timers onetothree-*"
echo
echo "Manual run:"
echo "  systemctl start onetothree-backup.service"
echo "  systemctl start onetothree-uptime.service"

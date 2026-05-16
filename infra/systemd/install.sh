#!/usr/bin/env bash
# Install OneToThree systemd user units (backup + uptime).
#
# Run as the deploy user (rudywolf), no sudo:
#   bash infra/systemd/install.sh
#
# Drops units into ~/.config/systemd/user/ and enables linger so the
# timers fire even when the user is not logged in. Idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/infra/systemd"
DEST="$HOME/.config/systemd/user"

[[ $EUID -ne 0 ]] || { echo "do NOT run as root — these are user units" >&2; exit 2; }

mkdir -p "$DEST"
for f in onetothree-backup.service onetothree-backup.timer \
         onetothree-uptime.service onetothree-uptime.timer; do
  install -m 0644 "$SRC/$f" "$DEST/$f"
  echo "installed $DEST/$f"
done

systemctl --user daemon-reload

systemctl --user enable --now onetothree-backup.timer
systemctl --user enable --now onetothree-uptime.timer

# enable-linger keeps user units running after logout. Requires polkit
# rules to allow without password — most distros allow loginctl
# enable-linger for the calling user out of the box.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "enabled linger for $USER"
  else
    echo "WARN: could not enable linger automatically. Run as root once:" >&2
    echo "  sudo loginctl enable-linger $USER" >&2
    echo "Without linger, the timers stop when you log out." >&2
  fi
fi

echo
echo "✓ installed."
echo
echo "Inspect:"
echo "  systemctl --user list-timers onetothree-*"
echo "  journalctl --user -u onetothree-backup.service -n 50"
echo "  journalctl --user -u onetothree-uptime.service -n 50"
echo
echo "Manual run:"
echo "  systemctl --user start onetothree-backup.service"
echo "  systemctl --user start onetothree-uptime.service"

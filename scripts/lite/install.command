#!/usr/bin/env bash
# OneToThree Lite — guided installer (macOS, double-clickable).
#
# Finder runs a .command file in Terminal on a double-click; it will not run a
# .sh. This is the file to click on a Mac. Everything it does is in install.sh.
#
# If macOS refuses to run it ("cannot be opened because it is from an
# unidentified developer"), right-click it once and choose Open.
cd "$(dirname "$0")"
exec bash ./install.sh

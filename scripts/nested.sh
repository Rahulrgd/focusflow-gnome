#!/usr/bin/env bash
# Launch a nested GNOME Shell (Wayland) session for testing.
# Inside it, open a terminal and run:
#   gnome-extensions enable focusflow@rahulrgd.github.io
set -euo pipefail

export MUTTER_DEBUG_DUMMY_MODE_SPECS="${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1366x768}"
export SHELL_DEBUG=all

exec dbus-run-session -- gnome-shell --nested --wayland

#!/usr/bin/env bash
# Dev install: compile schemas and symlink this repo into the user's extensions dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/metadata.json")"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$ROOT/schemas"

mkdir -p "$(dirname "$DEST")"
if [ -L "$DEST" ]; then
    ln -sfn "$ROOT" "$DEST"
elif [ -e "$DEST" ]; then
    echo "error: $DEST exists and is not a symlink; remove it first" >&2
    exit 1
else
    ln -s "$ROOT" "$DEST"
fi

echo "Installed $UUID -> $DEST"
echo "Wayland: start a nested session (scripts/nested.sh) or log out/in to load it."

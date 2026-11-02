#!/usr/bin/env bash
# Build an installable bundle in dist/: dist/<uuid>.shell-extension.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/dist"

gnome-extensions pack "$ROOT" \
    --force \
    --out-dir="$ROOT/dist" \
    --extra-source="$ROOT/icons" \
    --schema="$ROOT/schemas/org.gnome.shell.extensions.focusflow.gschema.xml"

ls -l "$ROOT"/dist/*.zip

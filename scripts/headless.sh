#!/usr/bin/env bash
# Throwaway headless GNOME Shell with FocusFlow enabled, isolated from the real desktop.
#
# Usage: scripts/headless.sh [options] [--] [command [args...]]
#   Starts the shell, runs <command> inside its D-Bus session, then tears everything down.
#   Default command: gnome-extensions info <uuid>
#
# Options:
#   --unsafe       start the shell with --unsafe-mode (needed for org.gnome.Shell.Eval)
#   --size WxH     virtual monitor size (default 1280x720)
#   --mem SIZE     RAM cap for the whole run, also used as the swap cap (default 2G)
#   --timeout SEC  seconds to wait for the shell to come up (default 30)
#
# Inside <command>: WAYLAND_DISPLAY, XDG_* and DBUS_SESSION_BUS_ADDRESS point at the
# test session; FF_TEST_DIR is the temp dir ($FF_TEST_DIR/shell.log, bus.log).
#
# Safety (each of these exists because test runs once filled RAM + swap and the OOM
# killer took VS Code down with them):
#   - The run lives in its own systemd scope with MemoryMax/MemorySwapMax, so a runaway
#     test gets killed on its own instead of whatever app launched it.
#   - gnome-shell spawns an ibus-daemon per run that outlived the shell and kept growing;
#     a no-op ibus-daemon stub on PATH stops it from starting at all.
#   - On exit the scope is stopped, which kills anything still left in it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/headless.sh"
UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/metadata.json")"

# ---------------------------------------------------------------------------
# Inner part: runs inside the scope and the private D-Bus session.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "__inner" ]; then
    shift
    # Our stderr was parked on fd 3; fd 2 (the bus log) stays with the bus daemon and the
    # services it activates, so their chatter goes to bus.log instead of the terminal.
    exec 2>&3 3>&-

    # Stub out ibus-daemon (gnome-shell finds it via PATH and does not retry).
    mkdir -p "$FF_TEST_DIR/bin"
    printf '#!/bin/sh\nexit 0\n' > "$FF_TEST_DIR/bin/ibus-daemon"
    chmod +x "$FF_TEST_DIR/bin/ibus-daemon"
    export PATH="$FF_TEST_DIR/bin:$PATH"
    export GTK_IM_MODULE=gtk-im-context-simple QT_IM_MODULE=simple XMODIFIERS=@im=none
    unset IBUS_ADDRESS

    mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions"
    ln -s "$ROOT" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"

    # Keep the shell from handing WAYLAND_DISPLAY of the real desktop to activated services.
    dbus-update-activation-environment WAYLAND_DISPLAY= 2>/dev/null || true
    unset WAYLAND_DISPLAY DISPLAY

    shell_args=(--headless --wayland --virtual-monitor "$FF_SIZE")
    [ "$FF_UNSAFE" = 1 ] && shell_args=(--unsafe-mode "${shell_args[@]}")
    gnome-shell "${shell_args[@]}" > "$FF_TEST_DIR/shell.log" 2>&1 &
    shell_pid=$!

    stop_shell() {
        kill -TERM "$shell_pid" 2>/dev/null || return 0
        for _ in $(seq 50); do
            kill -0 "$shell_pid" 2>/dev/null || return 0
            sleep 0.1
        done
        kill -KILL "$shell_pid" 2>/dev/null || true
    }
    trap stop_shell EXIT

    # Wait until the shell is on the bus and has loaded the extension (state no longer
    # UNKNOWN; it may be ACTIVE or ERROR, the command gets to look at either).
    deadline=$((SECONDS + FF_TIMEOUT))
    until gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: [A-Z]' &&
          ! gnome-extensions info "$UUID" 2>/dev/null | grep -q 'State: UNKNOWN'; do
        if ! kill -0 "$shell_pid" 2>/dev/null; then
            echo "headless: gnome-shell exited during startup" >&2
            exit 1
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "headless: gnome-shell not ready after ${FF_TIMEOUT}s" >&2
            exit 1
        fi
        sleep 0.2
    done
    export WAYLAND_DISPLAY=wayland-0

    if [ $# -eq 0 ]; then
        set -- gnome-extensions info "$UUID"
    fi
    set +e
    "$@"
    rc=$?
    set -e
    exit "$rc"
fi

# ---------------------------------------------------------------------------
# Outer part: option parsing, temp dirs, scope, cleanup.
# ---------------------------------------------------------------------------
FF_UNSAFE=0
FF_SIZE=1280x720
FF_MEM=2G
FF_TIMEOUT=30
while [ $# -gt 0 ]; do
    case "$1" in
        --unsafe)  FF_UNSAFE=1; shift ;;
        --size)    FF_SIZE="$2"; shift 2 ;;
        --mem)     FF_MEM="$2"; shift 2 ;;
        --timeout) FF_TIMEOUT="$2"; shift 2 ;;
        --)        shift; break ;;
        -h|--help) sed -n '2,24p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)        echo "headless: unknown option $1" >&2; exit 2 ;;
        *)         break ;;
    esac
done

glib-compile-schemas "$ROOT/schemas"

UNIT="focusflow-headless-$$"
FF_TEST_DIR="$(mktemp -d /tmp/ff-test.XXXXXX)"
# Short path: the Wayland socket path must stay under 108 bytes.
RUNTIME_DIR="/run/user/$(id -u)/ff-test-$$"
mkdir -m 700 "$RUNTIME_DIR"

cleanup() {
    rc=$?
    # Kills anything still running in the scope (stray daemons, a hung shell).
    systemctl --user stop "$UNIT.scope" 2>/dev/null || true
    if [ "$rc" -ne 0 ] && [ -s "$FF_TEST_DIR/shell.log" ]; then
        echo "--- last lines of shell.log ---" >&2
        tail -n 30 "$FF_TEST_DIR/shell.log" >&2
    fi
    # xdg-document-portal may have mounted a FUSE fs at $RUNTIME_DIR/doc; once the scope is
    # stopped that mount is dead and rm can't get past it.
    if mountpoint -q "$RUNTIME_DIR/doc" 2>/dev/null || [ -e "$RUNTIME_DIR/doc" ]; then
        fusermount3 -uz "$RUNTIME_DIR/doc" 2>/dev/null || fusermount -uz "$RUNTIME_DIR/doc" 2>/dev/null || true
    fi
    rm -rf "${FF_TEST_DIR:?}" "${RUNTIME_DIR:?}" ||
        echo "headless: could not fully remove $FF_TEST_DIR / $RUNTIME_DIR" >&2
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export FF_TEST_DIR FF_SIZE FF_UNSAFE FF_TIMEOUT

set +e
systemd-run --user --scope --quiet --collect --unit="$UNIT" \
    -p MemoryMax="$FF_MEM" -p MemorySwapMax="$FF_MEM" -- \
    env XDG_DATA_HOME="$FF_TEST_DIR/data" \
        XDG_CONFIG_HOME="$FF_TEST_DIR/config" \
        XDG_CACHE_HOME="$FF_TEST_DIR/cache" \
        XDG_STATE_HOME="$FF_TEST_DIR/state" \
        XDG_RUNTIME_DIR="$RUNTIME_DIR" \
    dbus-run-session -- "$SELF" __inner "$@" 3>&2 2>"$FF_TEST_DIR/bus.log"
rc=$?
set -e

if [ "$rc" -eq 137 ] || [ "$rc" -eq 143 ]; then
    # The scope's result reaches the journal a moment after systemd-run returns.
    for _ in $(seq 20); do
        if journalctl --user -u "$UNIT.scope" --no-pager -q 2>/dev/null | grep -q "oom-kill"; then
            echo "headless: run hit the $FF_MEM memory cap and was killed (raise it with --mem)" >&2
            break
        fi
        sleep 0.1
    done
fi
exit "$rc"

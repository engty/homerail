#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MACOS_DIR="$ROOT_DIR/homerail_macos"
ELECTRON_BIN="$MACOS_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

pkill -f "$ELECTRON_BIN" >/dev/null 2>&1 || true
npm --prefix "$MACOS_DIR" run build

launch_app() {
  "$ELECTRON_BIN" "$MACOS_DIR" &
  echo $!
}

case "$MODE" in
  run)
    launch_app >/dev/null
    ;;
  --debug|debug)
    lldb -- "$ELECTRON_BIN" "$MACOS_DIR"
    ;;
  --logs|logs)
    launch_app >/dev/null
    /usr/bin/log stream --info --style compact --predicate 'process == "Electron"'
    ;;
  --telemetry|telemetry)
    launch_app >/dev/null
    /usr/bin/log stream --info --style compact --predicate 'process == "Electron"'
    ;;
  --verify|verify)
    launch_app >/dev/null
    sleep 2
    pgrep -f "$ELECTRON_BIN" >/dev/null
    echo "HomeRail Miko Electron process is running."
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

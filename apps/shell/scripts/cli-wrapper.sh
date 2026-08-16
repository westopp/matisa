#!/bin/sh
# matisa — CLI for the Matisa app. Runs the bundled CLI under the app's own
# Electron binary in Node mode; --ensure-engine can start the same bundled
# engine the app uses, so both always meet at one daemon.
#
# Shipped to <Matisa.app>/Contents/Resources/bin/matisa and meant to be
# symlinked onto PATH from there — which is exactly why $0 cannot be used to
# locate the app. For a symlinked invocation $0 is the LINK
# (/usr/local/bin/matisa), so dirname yields /usr/local and every path built
# from it misses the bundle entirely. Walk the chain to the real file first.
#
# `readlink -f` collapses this to one line but is GNU-only — BSD readlink on
# macOS before 13 has no -f — hence the loop.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  # A relative link resolves against the directory the LINK lived in — not the
  # cwd, and not wherever the chain has walked to so far.
  case "$SELF" in
    /*) ;;
    *) SELF="$LINK_DIR/$SELF" ;;
  esac
done
RES="$(cd "$(dirname "$SELF")/.." && pwd)"

exec env ELECTRON_RUN_AS_NODE=1 MATISA_ENGINE_ENTRY="$RES/engine/engine.cjs" \
  "$RES/../MacOS/Matisa" "$RES/engine/cli.cjs" "$@"

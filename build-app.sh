#!/usr/bin/env bash
# Wrap the SPM-built binary into a .app bundle.
# Usage: ./build-app.sh [release|debug]
set -euo pipefail

CONFIG="${1:-release}"
APP_NAME="Matisa"
APP_DIR="build/${APP_NAME}.app"
ROOT="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT"

echo "→ Building ${APP_NAME} (${CONFIG})…"
if swift build -c "$CONFIG" --arch arm64 --arch x86_64 >/dev/null 2>&1; then
    UNIVERSAL=1
else
    swift build -c "$CONFIG"
    UNIVERSAL=0
fi

if [ "$UNIVERSAL" = "1" ]; then
    # Universal builds land in .build/apple/Products/<Config>
    case "$CONFIG" in
        release) BIN_PATH=".build/apple/Products/Release/${APP_NAME}" ;;
        debug)   BIN_PATH=".build/apple/Products/Debug/${APP_NAME}" ;;
        *)       BIN_PATH=".build/apple/Products/${CONFIG}/${APP_NAME}" ;;
    esac
else
    BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/${APP_NAME}"
fi

if [ ! -x "$BIN_PATH" ]; then
    echo "✗ Binary not found at $BIN_PATH"
    exit 1
fi

echo "→ Assembling ${APP_DIR}…"
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
cp "$BIN_PATH" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp Resources/Info.plist "${APP_DIR}/Contents/Info.plist"
if [ -f Resources/AppIcon.icns ]; then
    cp Resources/AppIcon.icns "${APP_DIR}/Contents/Resources/AppIcon.icns"
fi

echo "✓ Built ${APP_DIR}"
echo "  Run with: open ${APP_DIR}"

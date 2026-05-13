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

ENGINE_NAME="matisa-engine"

if [ "$UNIVERSAL" = "1" ]; then
    # Universal builds land in .build/apple/Products/<Config>
    case "$CONFIG" in
        release) BIN_DIR=".build/apple/Products/Release" ;;
        debug)   BIN_DIR=".build/apple/Products/Debug" ;;
        *)       BIN_DIR=".build/apple/Products/${CONFIG}" ;;
    esac
else
    BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
fi

APP_BIN="${BIN_DIR}/${APP_NAME}"
ENGINE_BIN="${BIN_DIR}/${ENGINE_NAME}"

if [ ! -x "$APP_BIN" ]; then
    echo "✗ App binary not found at $APP_BIN"
    exit 1
fi
if [ ! -x "$ENGINE_BIN" ]; then
    echo "✗ Engine binary not found at $ENGINE_BIN"
    exit 1
fi

echo "→ Assembling ${APP_DIR}…"
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"
cp "$APP_BIN" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp "$ENGINE_BIN" "${APP_DIR}/Contents/MacOS/${ENGINE_NAME}"
cp Resources/Info.plist "${APP_DIR}/Contents/Info.plist"

# Compile the Liquid Glass `.icon` source into the assets macOS Tahoe
# expects: `Assets.car` (layered, appearance-aware Liquid Glass icon, looked
# up by `CFBundleIconName`) plus a flat `Matisa.icns` (legacy bitmap
# fallback found via `CFBundleIconFile`). Requires Xcode 26's `actool` —
# older actool versions silently produce nothing.
if [ -d icon-assets/Matisa.icon ]; then
    echo "→ Compiling icon-assets/Matisa.icon…"
    ICON_TMP="$(mktemp -d)"
    if xcrun actool icon-assets/Matisa.icon \
            --app-icon Matisa \
            --compile "$ICON_TMP" \
            --output-partial-info-plist "$ICON_TMP/partial.plist" \
            --minimum-deployment-target 14.0 \
            --platform macosx \
            --target-device mac \
            --include-all-app-icons \
            --enable-on-demand-resources NO \
            --notices --warnings --errors >/dev/null 2>&1 \
       && [ -f "$ICON_TMP/Assets.car" ] && [ -f "$ICON_TMP/Matisa.icns" ]; then
        cp "$ICON_TMP/Assets.car" "${APP_DIR}/Contents/Resources/Assets.car"
        cp "$ICON_TMP/Matisa.icns" "${APP_DIR}/Contents/Resources/Matisa.icns"
        rm -rf "$ICON_TMP"
    else
        rm -rf "$ICON_TMP"
        echo "  ✗ actool failed (need Xcode 26+); falling back to Resources/AppIcon.icns"
        if [ -f Resources/AppIcon.icns ]; then
            cp Resources/AppIcon.icns "${APP_DIR}/Contents/Resources/AppIcon.icns"
        fi
    fi
elif [ -f Resources/AppIcon.icns ]; then
    cp Resources/AppIcon.icns "${APP_DIR}/Contents/Resources/AppIcon.icns"
fi

echo "✓ Built ${APP_DIR}"
echo "  Run with: open ${APP_DIR}"

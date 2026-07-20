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
# CLI is built as `matisa-cli` to avoid the case-insensitive APFS
# collision with the `Matisa` app product (both land in the same .build
# directory, and `matisa` / `Matisa` are the same path). It's installed
# into the bundle as the user-facing `matisa` filename below.
CLI_BUILD_NAME="matisa-cli"
CLI_INSTALL_NAME="matisa"

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
CLI_BIN="${BIN_DIR}/${CLI_BUILD_NAME}"

if [ ! -x "$APP_BIN" ]; then
    echo "✗ App binary not found at $APP_BIN"
    exit 1
fi
if [ ! -x "$ENGINE_BIN" ]; then
    echo "✗ Engine binary not found at $ENGINE_BIN"
    exit 1
fi
if [ ! -x "$CLI_BIN" ]; then
    echo "✗ CLI binary not found at $CLI_BIN"
    exit 1
fi

echo "→ Assembling ${APP_DIR}…"
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources/bin"
cp "$APP_BIN" "${APP_DIR}/Contents/MacOS/${APP_NAME}"
cp "$ENGINE_BIN" "${APP_DIR}/Contents/MacOS/${ENGINE_NAME}"
# Phase 4: the `matisa` CLI ships inside the bundle, in Resources/bin
# (Docker Desktop's pattern) — separate directory both to avoid case-
# collision with `Matisa`, and so the upcoming "Install command-line
# tool" affordance has a stable symlink target distinct from the engine
# binary. The user-facing filename is `matisa` even though the SPM
# product is `matisa-cli`; EngineLauncher.resolveBinaryURL() knows how
# to find the engine binary from this layout.
cp "$CLI_BIN" "${APP_DIR}/Contents/Resources/bin/${CLI_INSTALL_NAME}"
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

# Code signing — the key point here is *stable identity across rebuilds*.
# Without a stable cert, swift build's ad-hoc linker signing produces a
# new code identity every build, which invalidates any TCC permissions
# (Full Disk Access, per-folder Desktop/Documents prompts) on the previous
# build. With a stable self-signed cert, TCC keys permissions by that
# cert's identity and "Allow once" actually means once.
#
# Identity resolution, first match wins:
#   1. $MATISA_SIGNING_ID env var (escape hatch — e.g. for CI runs).
#   2. "Matisa Dev Signing" — the conventional self-signed name we
#      suggest below when no other identity is found.
#   3. Any "Apple Development: ..." identity in the user's keychain —
#      these come from being signed into Xcode with an Apple Developer
#      account and are far more convenient than asking the user to make
#      a new self-signed cert when they already have a stable one.
# If none match, we fall back to ad-hoc and emit step-by-step
# instructions for creating one.
resolve_signing_id() {
    local explicit="${MATISA_SIGNING_ID:-}"
    local identities
    identities="$(security find-identity -v -p codesigning 2>/dev/null)"

    if [ -n "$explicit" ] && echo "$identities" | grep -q "\"${explicit}\""; then
        echo "$explicit"
        return 0
    fi
    if echo "$identities" | grep -q '"Matisa Dev Signing"'; then
        echo "Matisa Dev Signing"
        return 0
    fi
    # `awk` pulls the quoted name from `security`'s output, e.g.
    #   "Apple Development: name@example.com (TEAMID)"
    local apple_dev
    apple_dev="$(echo "$identities" \
        | awk -F'"' '/"Apple Development:/ { print $2; exit }')"
    if [ -n "$apple_dev" ]; then
        echo "$apple_dev"
        return 0
    fi
    return 1
}

if SIGNING_ID="$(resolve_signing_id)"; then
    echo "→ Codesigning with identity: ${SIGNING_ID}"
    # Sign the CLI binary explicitly first. `codesign --deep` only
    # descends into the standard nested-code locations (MacOS/,
    # Frameworks/, PlugIns/, etc.) — anything under Contents/Resources/
    # is treated as a resource, not code, even when it's a Mach-O.
    # So the bundled CLI at Resources/bin/matisa would stay at its
    # linker-time ad-hoc signature unless we sign it by hand.
    codesign --sign "${SIGNING_ID}" --force \
        "${APP_DIR}/Contents/Resources/bin/${CLI_INSTALL_NAME}" \
        >/dev/null 2>&1 || true
    # Now sign the rest with --deep, which picks up Matisa and
    # matisa-engine in Contents/MacOS/ and seals the bundle.
    codesign --sign "${SIGNING_ID}" --force --deep "${APP_DIR}" \
        >/dev/null 2>&1 || {
            echo "  ✗ codesign failed — falling back to ad-hoc"
            codesign --sign - --force --deep "${APP_DIR}" >/dev/null 2>&1 || true
        }
else
    echo "→ Codesigning ad-hoc (no stable identity found)"
    codesign --sign - --force --deep "${APP_DIR}" >/dev/null 2>&1 || true
    cat <<EOM

  ⓘ This build is ad-hoc signed — TCC permissions (Desktop folder
    prompts, Full Disk Access grants) will reset on each rebuild
    because the code identity is regenerated.

    Options to make permissions persistent across rebuilds:

      • Easiest: sign into Xcode with an Apple Developer account —
        an "Apple Development: ..." identity will appear and this
        script will pick it up automatically next build.

      • Or: create a self-signed cert in Keychain Access:
        1. Open Keychain Access
        2. Menu: Keychain Access → Certificate Assistant →
           Create a Certificate…
        3. Name:               Matisa Dev Signing
           Identity Type:      Self Signed Root
           Certificate Type:   Code Signing
        4. Click Create, then Done.
        5. Re-run ./build-app.sh.

    To force a specific identity, export MATISA_SIGNING_ID.

EOM
fi

echo "✓ Built ${APP_DIR}"
echo "  Run with: open ${APP_DIR}"

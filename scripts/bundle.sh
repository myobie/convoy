#!/usr/bin/env bash
# Assemble Convoy.app from the ConvoyApp SPM executable — no Xcode, no swift-bundler.
#
# A macOS .app is just a directory layout + Info.plist + a signature. We build the SPM
# executable, lay out the bundle, drop in the Info.plist (LSUIElement + TCC usage keys), and
# codesign. Signing is SWAPPABLE: ad-hoc by default; set CONVOY_SIGN_IDENTITY to a Developer ID
# to produce a distributable, notarizable build later — no code changes required.
#
# Usage:
#   scripts/bundle.sh                         # release, ad-hoc signed → .build/bundler/Convoy.app
#   CONVOY_SIGN_IDENTITY="Developer ID Application: …" scripts/bundle.sh
#   CONFIG=debug scripts/bundle.sh
set -euo pipefail

cd "$(dirname "$0")/.."
CONFIG="${CONFIG:-release}"
SIGN_IDENTITY="${CONVOY_SIGN_IDENTITY:--}"   # "-" = ad-hoc
APP_NAME="Convoy"
OUT_DIR=".build/bundler"
APP="$OUT_DIR/$APP_NAME.app"

echo "==> building ConvoyApp ($CONFIG)"
swift build -c "$CONFIG" --product ConvoyApp

BIN=".build/$CONFIG/ConvoyApp"
[ -x "$BIN" ] || { echo "error: built binary not found at $BIN" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"
cp macos/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> signing ($([ "$SIGN_IDENTITY" = "-" ] && echo ad-hoc || echo "$SIGN_IDENTITY"))"
# --options runtime enables the hardened runtime (required for notarization); harmless ad-hoc.
codesign --force --deep --options runtime \
	--sign "$SIGN_IDENTITY" \
	"$APP"

echo "==> verifying"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

echo "✓ built $APP"
[ "$SIGN_IDENTITY" = "-" ] && echo "  (ad-hoc — right-click → Open the first time; set CONVOY_SIGN_IDENTITY for Developer ID)"
echo "  install: convoy app install --bundle $APP   (or via the brew cask)"

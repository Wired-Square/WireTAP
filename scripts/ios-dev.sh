#!/usr/bin/env bash
# Build a debug iOS app and deploy to a connected physical device.
# Usage: ./scripts/ios-dev.sh [device-name]
#   device-name  defaults to first connected device
set -euo pipefail

DEVICE="${1:-}"
BUNDLE_ID="com.wiredsquare.wiretap"
DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"

# --- 1. Build frontend ---
echo "▸ Building frontend…"
npm run build

# --- 2. Build iOS debug via Tauri ---
echo "▸ Building iOS (debug)…"
npx tauri ios build --debug

# --- 3. Find the .app in DerivedData ---
APP_PATH=$(find "$DERIVED_DATA"/wiretap-*/Build/Products/debug-iphoneos -maxdepth 1 -name "WireTAP.app" -type d 2>/dev/null | head -1)
if [ -z "$APP_PATH" ]; then
  echo "✘ Could not find WireTAP.app in DerivedData" >&2
  exit 1
fi
echo "▸ Found app: $APP_PATH"

# --- 4. Resolve device ---
if [ -z "$DEVICE" ]; then
  DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk 'NR>2 && /connected/ { print $1; exit }')
fi
if [ -z "$DEVICE" ]; then
  echo "✘ No connected device found" >&2
  exit 1
fi
echo "▸ Deploying to: $DEVICE"

# --- 5. Install ---
echo "▸ Installing…"
xcrun devicectl device install app --device "$DEVICE" "$APP_PATH"

# --- 6. Launch ---
echo "▸ Launching…"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"

echo "✔ Done — open Safari → Develop → $DEVICE for Web Inspector"

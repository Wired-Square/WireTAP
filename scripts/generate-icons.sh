#!/usr/bin/env bash
# Generate all platform icons from public/logo.svg
#
# Requirements:
#   - rsvg-convert (brew install librsvg)
#   - npx tauri icon (via @tauri-apps/cli)
#   - macOS sips and iconutil
#
# Usage:
#   ./scripts/generate-icons.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SVG="$ROOT_DIR/frontend/wiretap-ui/public/logo.svg"
TMP_PNG="$ROOT_DIR/crates/wiretap-app/icons/icon-1024.png"

if [ ! -f "$SVG" ]; then
  echo "Error: $SVG not found"
  exit 1
fi

if ! command -v rsvg-convert &>/dev/null; then
  echo "Error: rsvg-convert not found. Install with: brew install librsvg"
  exit 1
fi

echo "Rasterising logo.svg → icon-1024.png ..."
rsvg-convert -w 1024 -h 1024 "$SVG" -o "$TMP_PNG"

echo "Generating platform icons with tauri icon ..."
cd "$ROOT_DIR"
npx tauri icon "$TMP_PNG"

# macOS draws an app icon's body at 824 of 1024 px (Apple's icon grid), so its
# icons are padded; Windows and Android keep the full-bleed set.
echo "Padding the macOS icon.icns and icon.png ..."
ICONS="$ROOT_DIR/crates/wiretap-app/icons"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sips -z 824 824 "$TMP_PNG" --out "$WORK/padded.png" >/dev/null
sips --padToHeightWidth 1024 1024 "$WORK/padded.png" >/dev/null
mkdir "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$WORK/padded.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/padded.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$ICONS/icon.icns"
sips -z 512 512 "$WORK/padded.png" --out "$ICONS/icon.png" >/dev/null

echo "Done. All icons regenerated from public/logo.svg"

#!/usr/bin/env bash
# Generate all platform icons from public/logo.svg
#
# Requirements:
#   - rsvg-convert (brew install librsvg)
#   - npx tauri icon (via @tauri-apps/cli)
#
# Usage:
#   ./scripts/generate-icons.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SVG="$ROOT_DIR/public/logo.svg"
TMP_PNG="$ROOT_DIR/src-tauri/icons/icon-1024.png"

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

echo "Done. All icons regenerated from public/logo.svg"

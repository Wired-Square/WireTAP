#!/usr/bin/env bash
# Apply a stable adhoc code-signature to a built WireTAP.app so macOS Tahoe
# 26.4+ tracks the app consistently across rebuilds. Without this, the
# linker-signed adhoc identifier is randomised each build, the bundle's
# Info.plist is not bound to the signature, and TCC silently denies
# Bluetooth, mDNS / Bonjour, and Local Network access.
#
# See scripts/macos-dev-link.sh for the underlying TN3179 issue. That
# wrapper handles dev builds (where the binary runs out of target/ without
# a .app); this script handles bundled builds (release and --debug).
#
# Intended for local prod / prod-debug builds without a Developer ID. For
# distribution, set APPLE_SIGNING_IDENTITY before `tauri build` and this
# script no-ops.
#
# Usage: macos-bundle-sign.sh [<path/to/WireTAP.app>]
#        With no argument, signs whichever of target/{release,debug}/bundle/
#        macos/WireTAP.app exist.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entitlements="$script_dir/../src-tauri/Entitlements.plist"

if [[ $# -ge 1 ]]; then
  apps=("$1")
else
  apps=(
    "$script_dir/../src-tauri/target/release/bundle/macos/WireTAP.app"
    "$script_dir/../src-tauri/target/debug/bundle/macos/WireTAP.app"
  )
fi

signed_any=0
for app in "${apps[@]}"; do
  if [[ -d "$app" ]]; then
    codesign --force --sign - \
      --identifier com.wiredsquare.wiretap \
      --entitlements "$entitlements" \
      --generate-entitlement-der \
      "$app"
    echo "Resigned $app with stable identifier com.wiredsquare.wiretap"
    signed_any=1
  fi
done

if [[ "$signed_any" == "0" ]]; then
  echo "macos-bundle-sign: no WireTAP.app bundle found to sign" >&2
  exit 1
fi

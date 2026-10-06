#!/usr/bin/env bash
# Wraps a built WireTAP.app in an installer package whose postinstall links
# wiretap-can-cli onto PATH. Signs it when APPLE_INSTALLER_IDENTITY is set.
# Usage: macos-pkg.sh <WireTAP.app> <out.pkg>
set -euo pipefail

app="$1"
out="$2"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ditto "$app" "$work/root/$(basename "$app")"
# A relocatable bundle installs over any copy of the app the installer finds,
# which would leave the link pointing at nothing.
pkgbuild --analyze --root "$work/root" "$work/component.plist"
plutil -replace 0.BundleIsRelocatable -bool NO "$work/component.plist"

plist="$app/Contents/Info.plist"
pkgbuild --root "$work/root" \
  --component-plist "$work/component.plist" \
  --install-location /Applications \
  --scripts "$root/crates/wiretap-app/macos-pkg" \
  --identifier "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist").pkg" \
  --version "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist")" \
  "$work/component.pkg"

productbuild --package "$work/component.pkg" \
  ${APPLE_INSTALLER_IDENTITY:+--sign "$APPLE_INSTALLER_IDENTITY"} \
  "$out"

#!/usr/bin/env bash
# Linker wrapper that applies a stable adhoc code-signature to the WireTAP
# debug binary after each link.
#
# macOS Local Network Privacy (TN3179) tracks apps by their signed identity.
# Rust's linker-signed adhoc signature uses a randomised identifier
# (e.g. WireTAP-<hash>) that changes on every rebuild, and the embedded
# Info.plist is not bound to the signature. macOS Tahoe 26.4+ responds by
# treating each rebuild as a new untrusted app and silently returning
# EHOSTUNREACH for LAN traffic plus empty results for Bonjour/mDNS scans.
#
# This wrapper invokes the real linker, then re-signs WireTAP with the
# release identifier (com.wiredsquare.wiretap) and binds the debug
# entitlements so lldb can still attach.
set -euo pipefail

output=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    output="$arg"
  fi
  prev="$arg"
done

cc "$@"

if [[ -n "$output" && "$(basename "$output")" == "WireTAP" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  entitlements="$script_dir/../src-tauri/WireTAP-debug.entitlements"
  codesign --force --sign - \
    --identifier com.wiredsquare.wiretap \
    --entitlements "$entitlements" \
    --generate-entitlement-der \
    "$output" >/dev/null
fi

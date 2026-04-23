#!/usr/bin/env bash
# Runs `tauri dev` with the macOS linker wrapper that applies a stable
# adhoc code-signature to the debug binary after each link. See
# scripts/macos-dev-link.sh for the why.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname)" == "Darwin" ]]; then
  linker="$script_dir/macos-dev-link.sh"
  export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$linker"
  export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER="$linker"
fi

exec npx tauri dev "$@"

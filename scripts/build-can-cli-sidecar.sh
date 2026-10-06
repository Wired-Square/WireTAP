#!/usr/bin/env bash
# Builds wiretap-can-cli for a target and puts it where `bundle.externalBin`
# in tauri.can-cli.conf.json expects it.
# Usage: build-can-cli-sidecar.sh [<target-triple>]   (default: the host)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
ext=""
[[ "$target" == *windows* ]] && ext=".exe"

cargo build --release -p wiretap-can-cli --target "$target" --manifest-path "$root/Cargo.toml"
mkdir -p "$root/crates/wiretap-app/binaries"
cp "$root/target/$target/release/wiretap-can-cli$ext" \
  "$root/crates/wiretap-app/binaries/wiretap-can-cli-$target$ext"

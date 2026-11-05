#!/usr/bin/env bash
# Notarisation with the Apple account in .env.
# Usage: macos-notarise.sh build
#        macos-notarise.sh history | log <id> | info <id>
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -e .env ]] && eval "$(cat .env)"

case "${1:?usage: macos-notarise.sh build | history | log <id> | info <id>}" in
  build) APPLE_PASSWORD="$APPLE_NOTARY_PASSWORD" exec bash scripts/tauri.sh build ;;
  *) exec xcrun notarytool "$@" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_NOTARY_PASSWORD" ;;
esac

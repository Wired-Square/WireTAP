#!/usr/bin/env bash
# The app crate and the frontend no longer sit where `tauri` looks by default.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TAURI_APP_PATH="$root/crates/wiretap-app"
export TAURI_FRONTEND_PATH="$root/frontend/wiretap-ui"

# Every installer carries wiretap-can-cli.
if [[ "${1:-}" == "build" ]]; then
  target=""
  args=("$@")
  for i in "${!args[@]}"; do
    case "${args[$i]}" in
      --target=*) target="${args[$i]#--target=}" ;;
      --target | -t) target="${args[$((i + 1))]:-}" ;;
    esac
  done
  bash "$root/scripts/build-can-cli-sidecar.sh" ${target:+"$target"}
  set -- build --config "$TAURI_APP_PATH/tauri.can-cli.conf.json" "${@:2}"
fi

exec npx tauri "$@"

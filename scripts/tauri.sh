#!/usr/bin/env bash
# The app crate and the frontend no longer sit where `tauri` looks by default.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TAURI_APP_PATH="$root/crates/wiretap-app"
export TAURI_FRONTEND_PATH="$root/frontend/wiretap-ui"

exec npx tauri "$@"

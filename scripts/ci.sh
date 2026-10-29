#!/usr/bin/env bash
# The CI definition. The pre-push hook and the release script call this rather
# than restating it. Everyday: text gates, clippy (also for Windows), the Rust
# and frontend suites. --tag adds a clean release build of every target this
# host can reach, once per clean commit.
#
#   scripts/ci.sh [--tag]
set -euo pipefail
cd "$(dirname "$0")/.."

all=false
[[ ${1:-} == --tag ]] && all=true

die() { printf 'ci: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== [%ss] %s\n' "$SECONDS" "$*"; }
skip() { printf '\n== [%ss] skipped: %s\n' "$SECONDS" "$*"; }

root=$PWD
tag_dir=$root/target/ci-tag
stamp=
if $all && [[ -z $(git status --porcelain) ]]; then
  stamp=$tag_dir/passed/$(git rev-parse HEAD)
  [[ ! -e $stamp ]] || { printf 'ci: --tag already passed at %s\n' "$(git rev-parse --short HEAD)"; exit 0; }
fi

win=x86_64-pc-windows-msvc
cross_windows=false
[[ $(rustc -vV | sed -n 's/^host: //p') == *windows* ]] || cross_windows=true
! $cross_windows || rustup target list --installed | grep -qx $win || die "$win missing: rustup target add $win"
# Clippy needs no object code or resources, and the C and RC sources cannot be built for msvc off Windows.
if $cross_windows; then
  stubs=$root/target/ci/stubs
  mkdir -p "$stubs"
  printf '#!/bin/sh\nfor a; do case $a in -out:*) touch "${a#-out:}";; esac; done\n' >"$stubs/ar"
  printf '#!/bin/sh\n[ "$1" = -V ] && { echo "OVERVIEW: LLVM Resource Converter -no-preprocess"; exit; }\nwhile [ $# -gt 1 ]; do [ "$1" = /fo ] && touch "$2"; shift; done\n' >"$stubs/rc"
  chmod +x "$stubs/ar" "$stubs/rc"
  export CC_x86_64_pc_windows_msvc=true AR_x86_64_pc_windows_msvc="$stubs/ar" RC_x86_64_pc_windows_msvc="$stubs/rc"
fi

step "Installed packages match the lockfile"
npm ls --all >/dev/null || die "node_modules is out of step with package-lock.json: npm ci"

step "No local instructions are tracked"
[[ -z $(git ls-files -- ':(glob)**/CLAUDE.md' ':(glob)**/.claude/**') ]] \
  || die "CLAUDE.md or .claude/ is tracked: git rm --cached it"

step "No attribution in this branch's commit messages"
if base=$(git merge-base HEAD origin/main 2>/dev/null); then
  ! git log --format=%B "$base..HEAD" | grep -niE 'Co-Authored-By: Claude|Generated with \[?Claude Code' \
    || die "a commit message carries an attribution line; reword it"
fi

step "No Cargo path dependency leaves the repository"
leaves() {
  local depth=0 seg segs
  [[ $2 != /* ]] || return 0
  IFS=/ read -ra segs <<<"$1/$2"
  for seg in "${segs[@]}"; do
    case $seg in
      '' | .) ;;
      ..) ((--depth >= 0)) || return 0 ;;
      *) ((++depth)) ;;
    esac
  done
  return 1
}
while IFS=: read -r file line text; do
  path=$(sed -E 's/.*path *= *"([^"]*)".*/\1/' <<<"$text")
  ! leaves "$(dirname "$file")" "$path" || die "$file:$line points outside the repository: $path"
done < <(git grep -nE '(^|[^A-Za-z0-9_-])path *= *"' -- ':(glob)**/Cargo.toml')

# A clean checkout has neither a live database nor a .sqlx cache.
step "No compile-time-checked sqlx query"
! git grep -nE --untracked 'sqlx::(query|query_as|query_scalar|query_file)[a-z_]*!' -- '*.rs' \
  || die "a sqlx query! macro needs a database to build; use the runtime sqlx::query API"

step "Clippy"
cargo clippy --workspace --all-targets --locked

if $cross_windows; then
  step "Clippy for $win"
  cargo clippy -p wiretap -p wiretap-can-cli -p wiretap-capture-store --target $win --locked
fi

step "Rust tests"
cargo test --workspace --locked

step "Frontend typecheck and tests"
(cd frontend/wiretap-ui && npx tsc --noEmit && npx vitest run)

if $all; then
  # Built from the commit outside the checkout, so no local cargo override applies.
  export CARGO_NET_GIT_FETCH_WITH_CLI=true
  unset CARGO_TARGET_DIR APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_INSTALLER_IDENTITY SENTRY_AUTH_TOKEN
  src=$(mktemp -d)
  trap 'rm -rf "$src"' EXIT
  mkdir -p "$tag_dir/target"
  git archive HEAD | tar -x -m -C "$src"
  ln -s "$tag_dir/target" "$src/target"
  (cd "$src" && npm ci --no-audit --no-fund >/dev/null)

  if [[ $(uname) == Darwin ]]; then
    for t in aarch64-apple-darwin x86_64-apple-darwin; do
      rustup target list --installed | grep -qx $t || die "$t missing: rustup target add $t"
      step "Release build: $t"
      (cd "$src" && bash scripts/tauri.sh build --target $t --bundles app)
      bundle=$tag_dir/target/$t/release/bundle
      app=$bundle/macos/WireTAP.app
      version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")
      mkdir -p "$bundle/pkg"
      (cd "$src" && bash scripts/macos-pkg.sh "$app" "$bundle/pkg/WireTAP_${version}_$t.pkg")
    done
  else
    skip "macOS builds: not a macOS host"
  fi

  linux=
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    case $(docker version --format '{{.Server.Arch}}') in
      arm64) linux=aarch64-unknown-linux-gnu; skip "x86_64-unknown-linux-gnu: Docker here runs arm64 images only" ;;
      amd64) linux=x86_64-unknown-linux-gnu; skip "aarch64-unknown-linux-gnu: Docker here runs amd64 images only" ;;
      *) skip "Linux builds: Docker's architecture has no Linux target" ;;
    esac
  else
    skip "Linux builds: Docker is not running"
  fi
  if [[ -n $linux ]]; then
    # The host fetches every source with its own keys and registry token; the container builds offline.
    step "Vendor sources for $linux"
    (cd "$src" && cargo vendor --locked "$tag_dir/vendor") | sed "s|directory = .*|directory = \"/vendor\"|" >"$tag_dir/vendor.toml"
    { sed -n '/^\[registries.wired-square\]/,/^$/p' .cargo/mirror.toml; printf '[net]\noffline = true\n'; } >>"$tag_dir/vendor.toml"
    step "Release build: $linux"
    docker build -q -t wiretap-ci-linux -f scripts/ci/linux.Dockerfile scripts/ci >/dev/null
    git archive HEAD | docker run --rm -i \
      -v wiretap-ci-linux-target:/work/target -v wiretap-ci-linux-cache:/root/.cache \
      -v "$tag_dir/vendor:/vendor:ro" -v "$tag_dir/vendor.toml:/usr/local/cargo/config.toml:ro" \
      wiretap-ci-linux bash -c "set -e; mkdir src; tar -x -m -C src; cd src; ln -s /work/target target
        npm ci --no-audit --no-fund >/dev/null; bash scripts/tauri.sh build --target $linux"
  fi

  skip "$win: no MSVC toolchain off Windows; the everyday clippy covers cfg(windows)"
fi

[[ -z $stamp ]] || { mkdir -p "$(dirname "$stamp")" && touch "$stamp"; }
printf '\nci: ok\n'

# Contributing to WireTAP

This guide covers building WireTAP from source, working on it against local
checkouts of its libraries, and getting a change merged. [README.md](README.md)
says what the app does.

## The repositories

WireTAP is one of three public repositories. Most changes touch only this one,
but hardware support and protocol work usually start in a library.

| Repository | What it holds | How WireTAP uses it |
|---|---|---|
| [WireTAP](https://github.com/Wired-Square/WireTAP) | The Tauri app, `wiretap-can-cli`, the capture store and the analysis crate | — |
| [wslib-rs](https://github.com/Wired-Square/wslib-rs) | Shared Rust crates: the CAN adapter drivers (`wslib-can-*`), serial, Modbus, FrameLink, the catalogue, the wire protocol and more | About 25 `wslib-*` crates, from the `wired-square` Cargo registry |
| [wslib-ts](https://github.com/Wired-Square/wslib-ts) | Shared TypeScript packages | `@wired-square/canvas`, `@wired-square/store` and `@wired-square/mcp-bridge`, from the `@wired-square` npm scope |

The libraries are not on crates.io or npmjs.com. They are published to a
Wired Square registry, which has a public mirror that anyone can read without
a token:

- Cargo: `https://mirror.wiredsquare.com/cargo/`
- npm: `https://mirror.wiredsquare.com/npm/`

## Prerequisites

- **Rust 1.99**, the version CI builds with (`rustup`).
- **Node 22** and npm.
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for
  your platform: the Xcode command-line tools on macOS, the MSVC build tools
  and WebView2 on Windows, and on Debian or Ubuntu:

  ```sh
  sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev xdg-utils
  ```

## Building

### 1. Point Cargo at the registry mirror

The manifests name the registry `wired-square`, and `Cargo.lock` records its
canonical address. Tell Cargo to read the mirror in its place. Do this once
per machine, by appending the repo's mirror config to your Cargo config:

```sh
git clone https://github.com/Wired-Square/WireTAP.git
cd WireTAP
cat .cargo/mirror.toml >> ~/.cargo/config.toml
```

CI does the same thing. The lockfile is unchanged, so the same `Cargo.lock`
builds against either address. npm needs no setup:
`frontend/wiretap-ui/.npmrc` already points the `@wired-square` scope at the
mirror.

### 2. Build and run

```sh
npm install
npm run tauri:dev
```

The first build compiles the whole dependency tree, which takes a few minutes.
`npm run dev` starts Vite alone, which is enough for UI work that does not
need the Rust side.

### 3. Run the tests

```sh
cargo test -p wiretap --lib                      # the app's Rust suite
cargo test --workspace                           # every crate
cd frontend/wiretap-ui && npx vitest run && npx tsc --noEmit
```

`scripts/ci.sh` is the full CI definition: text gates, clippy (native and for
Windows), and both suites. See the README's *Local CI* section for the targets
it needs. Install the pre-push hook to run it before every push:

```sh
git config core.hooksPath scripts/hooks
```

`scripts/ci.sh --tag` builds the release packages. You don't need it for a
contribution.

## Working against local library checkouts

When a change spans WireTAP and a library, for example a new CAN adapter
driver in wslib-rs, build WireTAP against your local checkout of the library
instead of the published version. Clone the libraries next to WireTAP:

```sh
git clone https://github.com/Wired-Square/wslib-rs.git
git clone https://github.com/Wired-Square/wslib-ts.git
```

```
src/
├── WireTAP/
├── wslib-rs/
└── wslib-ts/
```

### Rust: patch the `wired-square` registry

Create `WireTAP/.cargo/config.toml`. Git ignores everything in `.cargo/` except
`mirror.toml`, so this file never reaches a commit. Add a `[patch.wired-square]`
table. Relative paths resolve from the WireTAP directory:

```toml
[patch.wired-square]
wslib-can = { path = "../wslib-rs/crates/wslib-can" }
wslib-can-pcan = { path = "../wslib-rs/crates/wslib-can-pcan" }
# …
```

**Patch every `wslib-*` crate WireTAP uses, not only the one you are changing.**
Inside wslib-rs, crates refer to each other by path. So a patched `wslib-can`
pulls in local copies of `wslib-tcp`, `wslib-serial` and others, while WireTAP
still takes its own direct dependencies on those crates from the registry. The
build then holds two copies of one crate, and fails with errors like
*"there are multiple different versions of crate `wslib_serial`"*. Patching the
whole set avoids that. This writes the table from the lockfile:

```sh
bash -c '
names=$(awk -F\" "/^name = \"wslib-/ {print \$2}" Cargo.lock | sort -u)
mkdir -p .cargo
{ echo "[patch.wired-square]"
  for n in $names; do echo "$n = { path = \"../wslib-rs/crates/$n\" }"; done
} > .cargo/config.toml
cargo update $names'
```

The `cargo update` step matters. A patch whose version differs from the one
locked in `Cargo.lock` is ignored with *"patch … was not used in the crate
graph"* until the lockfile is updated.

A local crate whose version has moved past WireTAP's requirement is also
ignored, with the same warning: for example, wslib-rs at `wslib-mcu-flash 0.2`
while WireTAP asks for `0.1`. WireTAP keeps the registry copy of that crate.
That is harmless unless your change is in that crate. If it is, raise the
requirement in the WireTAP `Cargo.toml` that names it.

To go back to the published crates:

```sh
rm .cargo/config.toml
git checkout Cargo.lock
```

**Never commit a `Cargo.lock` that has path entries in it.** A WireTAP PR builds
against published library versions only (see
[Changes that span repositories](#changes-that-span-repositories)).

### TypeScript: install a packed package

The `@wired-square` packages declare React as a peer dependency. If you link
one in with `npm link` or a `file:` path, it resolves React from wslib-ts's own
`node_modules`, and the app ends up with two Reacts. Pack the package and
install the tarball instead:

```sh
cd ../wslib-ts
npm install
npm pack -w @wired-square/canvas --pack-destination /tmp   # prepack builds dist/
cd ../WireTAP
npm install --no-save -w frontend/wiretap-ui /tmp/wired-square-canvas-*.tgz
```

`--no-save` leaves `package.json` and `package-lock.json` alone. Repack and
reinstall after each change. `npm ci` puts the published version back.

## Example: adding a CAN adapter

This example adds support for a new CAN adapter, start to finish. PCAN-USB is a
real case: `wslib-can-pcan` exists in wslib-rs and `wiretap-can-cli` already
drives it, but the app does not. Use `gs_usb` as the model throughout. It is
the closest existing adapter, a USB device driven over `nusb`.

### 1. The driver, in wslib-rs

Each adapter is a `wslib-can-<name>` crate. Model a new one on
`wslib-can-gsusb` or `wslib-can-pcan`. The protocol codec has no I/O, and a
`transport` feature runs it as a task over the shared types in `wslib-can`:
frames, length codes and the task interface. Add tests against captured
traffic. Follow wslib-rs's own README for its CI and conventions.

### 2. Prove it in `wiretap-can-cli`

The CLI is the quickest way to see frames from real hardware. It is a
can-utils work-alike with no UI and no session machinery. Add the crate to
`crates/wiretap-can-cli/Cargo.toml`, an interface prefix in `src/iface.rs`
(as `pcan:<serial>/<channel>`), and a listing in `list` (`src/main.rs`). Then:

```sh
cargo run -p wiretap-can-cli -- list
cargo run -p wiretap-can-cli -- dump pcan:0012ABCD/0
cargo run -p wiretap-can-cli -- pattern …   # Test Pattern, to prove the link both ways
```

### 3. The device kind, in the app's Rust

A device kind is a string, such as `"gs_usb"`, keyed through a few tables
under `crates/wiretap-app/src/`. Search for `"gs_usb"` and add a row or arm
beside each match:

| File | What to add |
|---|---|
| `Cargo.toml` (`wiretap-app`) | The `wslib-can-<name>` dependency, under the right platform `cfg` |
| `io/profile/kinds.rs` | The connection map: defaults (bitrate, sample point, channel, FD) and required fields |
| `io/device_kinds.rs` | Its `KindTraits`. `available` must match the `cfg` on the spawner arm |
| `io/traits.rs` | The protocols it carries (CAN, CAN FD), and when it cannot transmit (listen-only) |
| `io/<name>/` | Device listing and probing, as `io/gs_usb/` does, with the `#[tauri::command]`s the picker calls |
| `io/broker/spawner.rs` | A `run_<name>_reader` arm that reads the profile and starts the transport |
| `io/probe.rs` | The probe arm, for the connection test in the profile editor |
| `sessions/source_config.rs` | Its default bus mapping |
| `profile_tracker.rs`, `transmit.rs` | Only if one session at a time holds the device (`single_handle`) |

Convert the wire's length code to a byte count in the driver: a frame's `dlc`
is always a byte count in WireTAP, and `wiretap_protocol::dlc` is the only
table. Then regenerate the TypeScript types, and update the golden fixtures
the tests name:

```sh
npm run gen:types
cargo test -p wiretap --lib
```

### 4. The profile editor, in the frontend

Paths are under `frontend/wiretap-ui/src/`:

| File | What to add |
|---|---|
| `settings/appSettings.ts` | The kind in the profile-kind union, and its connection type |
| `api/<name>.ts` | `invoke()` wrappers for the list and probe commands (see `api/gs_usb.ts`) |
| `components/io/IOConnectionFields.tsx` | The connection form |
| `components/io/<Name>DevicePicker.tsx` | A device picker, if the adapter is chosen by serial number |
| `apps/settings/views/DataIOView.tsx` | Its summary line in the profile list |
| `locales/en-AU/settings.json` | The labels |

Use the UI primitives (`Input`, `Select`, `Checkbox` and the rest) rather than
raw elements. Run `npm run gen:css` after adding a class name.
`docs/style_guide.md` has the rules.

### 5. Prove it end to end

Create a profile for the adapter, open it in Discovery, and run the Test
Pattern app against a second adapter or a `wiretap-can-cli pattern`
responder. Sweep mode exercises CAN FD.

### 6. Docs

Add the adapter to the *Supported Hardware* table in `README.md`, and add an
entry under `[Unreleased]` in `CHANGELOG.md`. The entry is two to four
sentences for users: what changed and what to do.

## Changes that span repositories

A WireTAP PR builds against published library versions. When a change needs a
library change too:

1. Open the library PR first: wslib-rs or wslib-ts. A maintainer publishes
   the new version once it is merged.
2. Open the WireTAP PR against that published version. Bump the requirement
   in `Cargo.toml` or `package.json` and commit the updated lockfile.

You can open both at once while you iterate locally against the patch. Link
them to each other, and mark the WireTAP PR as a draft until the library
version is out.

## Conventions

- **Branch and PR.** Fork, branch off `main`, and open a pull request. PRs are
  squash-merged.
- **Commits.** An imperative subject line under about 70 characters. Add a
  body only when the *why* isn't obvious, and keep it to a short paragraph.
- **Australian English** in UI text, comments, docs and identifiers: *colour*,
  *behaviour*, *serialise*.
- **Rust does the work, TypeScript renders.** Parsing, decoding, validation
  and anything a headless build could need goes in Rust, behind a command, with
  a test. The frontend draws the results. Shapes TypeScript needs from Rust
  are generated (`npm run gen:types`), never written by hand.
- **No CSS framework.** `styles/utilities.css` is generated from the class
  names in `src/`. Colours come only from the theme variables.
- **Translations.** UI text lives in `src/locales/en-AU/`. A dev build offers
  a pseudo language in Settings → General → Language that wraps every
  translated string in ⟦…⟧, so any text still in plain English is not
  translated. Run `npm run gen:pseudo` after editing en-AU; the tests fail
  until you do.
- **Few comments.** Prefer names and structure that explain themselves.
  Comment only a non-obvious *why*.
- Code-coupled design notes are in `docs/`. Read `docs/session-flow.md` and
  `docs/capture-flow.md` before you touch sessions or capture.

## Licence

WireTAP is MIT-licensed (see [LICENSE](LICENSE)). By contributing, you agree
that your contribution is licensed the same way.

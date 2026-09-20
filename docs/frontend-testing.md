# Frontend testing

What can actually be asserted about the frontend, and what each surface costs.
Read this before reaching for a browser automation tool — the obvious answers
(Playwright, WebDriver) are ruled out or expensive here for reasons that are not
obvious.

## What exists

**vitest only.** 27 files, ~220 tests, `environment: "node"`
([vite.config.ts](../frontend/wiretap-ui/vite.config.ts)). There is **no
@testing-library, no Playwright, no WebDriver**, and two DOM tests:
`src/tests/dialogTabTrap.test.tsx` (the dialog rendered, Tab trapped) and
`src/tests/primitiveBehaviour.test.ts` (the dismiss stack, focus movement and
popover placement under the primitives, no React) opt into jsdom with a
`// @vitest-environment jsdom` pragma. Every other test is a pure-logic test
over stores, utils, and hook logic.

That is a deliberate shape, not a gap left by accident — the app's logic lives
in Zustand stores and pure modules precisely so it can be tested without a DOM.
Keep new logic testable that way; the pragma is for a primitive's DOM contract,
not for a store that could have been tested without one.

```
npm run test:run    # vitest, one shot
npm run build       # tsc && vite build — the type check
npm run gen:css     # regenerate src/styles/utilities.css after adding a utility class
```

## The four surfaces

| | Can assert | Cannot assert | Cost |
|---|---|---|---|
| **vitest (logic)** | Store transitions, pure functions, cross-language pins | Anything rendered | None — it is there |
| **MCP bridge** | What the frontend *computed* from a live session | Clicks, labels, layout | App must be running with MCP on |
| **Screenshots** | How it looks, in both themes | Anything programmatic | None |
| **Playwright + IPC stub** | Clicks, form behaviour, dialogs | Anything touching a real device | ~a day of setup, new dependency |

### vitest — the default

Two patterns worth copying rather than inventing:

- **Static-analysis guards.** `src/tests/sessionCallbackCoverage.test.ts` parses
  `sessionStore.ts` and asserts a property over its text (declared callbacks ⊆
  dispatched). Types cannot catch that class — an optional callback with no
  dispatcher is well-typed — and neither can a behavioural test, because it only
  covers the case you remembered to write. Reach for this whenever the invariant
  is "these two lists agree". `src/tests/utilitiesCss.test.ts` is the same shape
  over the utility sheet: `src/styles/utilities.css` is generated from the class
  names in the source by `scripts/gen-utilities.mjs`, and the guard asserts the
  committed sheet matches a fresh generation, that every class the token layer
  names compiles, and that every `var(--x)` a component or `WireTAP.css` reads is
  declared. A new utility class fails the first assertion until `npm run gen:css`
  is run; a typo in a class name fails generation outright.
- **Cross-language pins.** There is no ts-rs or specta in this project, so a
  shared shape is pinned by a test that parses the *other* language's source. It
  already runs in both directions: a Rust test parses
  `src/api/framelinkAxes.ts`, and the connection-defaults table
  (`crates/wiretap-app/src/io/device_kinds.rs`) is the reverse case. Prefer this to
  hand-copying a table and hoping.

### MCP bridge — the only real end-to-end

There is a **reverse RPC channel, Rust → frontend**
([src/services/mcpBridge.ts](../frontend/wiretap-ui/src/services/mcpBridge.ts)), so an agent or
script driving the MCP server can ask the running frontend what it computed.
It exposes exactly four methods:

| Method | MCP tool | Use |
|---|---|---|
| `discovery.analysis` | `get_discovery_analysis` | read back Discovery's analysis |
| `decoder.signals` | `get_decoded_signals` | read back decoded signals |
| `live.frameMap` | `get_live_frame_map` | read back the live frame map |
| `ui.openPanel` | `open_app` | drive: open a panel |

Plus `attach_source`, which surfaces a session in a source-aware tab. Requires
the app running, `mcp_server_enabled`, and the relevant control permissions in
Settings. This is genuine end-to-end — it asserts on real frontend output over a
real session — but its vocabulary is data, not UI. It cannot click a button,
read a label, or see a dialog.

### Screenshots

`screencapture` on macOS, then read the PNG. No setup, and the right tool for
"does this look correct in both themes" — which matters here because theming
is CSS variables swapped at runtime, so a theme bug is invisible to every other
surface.

### Playwright — possible, but understand what it tests

The only route to click-and-assert on macOS, and it needs an **IPC stub**.
`npm run dev` serves the frontend to a browser at `localhost:1420`, but there is
no Tauri there, so every `invoke()` throws. A fixture must install a fake
`window.__TAURI_INTERNALS__.invoke` before the app boots.

That means it tests the frontend **against mocks**, which is exactly right for
form validation, dialog flow and picker behaviour, and worthless for anything
that touches a device. Weigh it against how much dialog-and-form work is coming;
it is not worth a browser download and a new dependency for one form.

## What is not available

- **WebDriver / `tauri-driver`.** It wraps WebKitWebDriver (Linux) and Edge
  Driver (Windows). Apple ships no WKWebView WebDriver, so there is **no macOS
  path**. A Linux or Windows runner is the only way to get it.
- **`window.__TAURI__` in a console.** `withGlobalTauri` is absent from
  `crates/wiretap-app/tauri.conf.json`, so it defaults to false and the global is not
  injected. Calling `invoke` by hand from the WebView inspector needs that
  turned on first.
- **An HTTP surface for Tauri commands.** They are IPC. See below.

## The backend is not browsable

A recurring question, so: **you cannot point a browser at a Tauri command.**
Two things do listen on loopback, and neither helps.

| | Port | Auth | From a browser |
|---|---|---|---|
| WS binary transport ([ws/server.rs](../crates/wiretap-app/src/ws/server.rs)) | `127.0.0.1:0` — ephemeral, new each run | 32-hex token, new each run | Socket opens; cannot authenticate |
| MCP server ([mcp/mod.rs](../crates/wiretap-app/src/mcp/mod.rs)) | `127.0.0.1:8787` default, opt-in | Bearer token in Settings | Rejected — see below |

The WS port is logged; the token deliberately is not (`lib.rs` discards it as
`_token`). The frontend gets both from `invoke("get_ws_config")`, so the only
route to the token is from inside the app — and the protocol is custom binary
framing, so there would be nothing to browse with it.

The MCP server is real HTTP, but validates `Origin` against its own loopback
port and nothing else. That is the DNS-rebinding defence the MCP spec requires,
and it is aimed at exactly this: MCP clients send no `Origin` header, a browser
always does. So `curl` works and `fetch()` from a page does not, by design.

Separately, the **WireTAP gateway** (`http://localhost:8423`, the `wiretap`
device kind) *is* a browsable HTTP service — but it is a different product, not
this app's backend.

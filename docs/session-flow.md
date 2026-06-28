# Session Flow

This document describes how IO sessions are created, joined, driven, and torn
down in WireTAP. It is the canonical reference for the session subsystem.
For capture lifecycle and ownership, see [capture-flow.md](capture-flow.md).

## Architecture layers

```
┌─────────────────────────────────────────────────────────────────┐
│  UI                                                             │
│  Session chip + menu · IoSourcePickerDialog                     │
├─────────────────────────────────────────────────────────────────┤
│  useIOSessionManager        app-level orchestration             │
├─────────────────────────────────────────────────────────────────┤
│  useIOSession               per-subscriber React hook           │
├─────────────────────────────────────────────────────────────────┤
│  sessionStore               Zustand state, WS message routing   │
├─────────────────────────────────────────────────────────────────┤
│  WebSocket transport        binary frame/event delivery         │
├─────────────────────────────────────────────────────────────────┤
│  Rust backend (io/mod.rs)   IOSource trait, session lifecycle   │
└─────────────────────────────────────────────────────────────────┘
```

All frame data and most session events are delivered over a local WebSocket
rather than Tauri events — see [§ WebSocket transport](#websocket-transport).

---

## 1. Source traits

Every IO source declares its capabilities via two embedded structs on
`IOCapabilities` ([src-tauri/src/io/traits.rs](../src-tauri/src/io/traits.rs)):

```
┌──────────────────────────────────────────────────────────┐
│  InterfaceTraits                                         │
│    temporal_mode:  "realtime" | "recorded"               │
│    protocols:      ["can"] | ["canfd","can"]             │
│                    | ["serial"] | ["modbus"] | ...       │
│    tx_frames:      bool  (CAN, Modbus, framed serial)    │
│    tx_bytes:       bool  (raw serial)                    │
│    multi_source:   bool                                  │
├──────────────────────────────────────────────────────────┤
│  SessionDataStreams                                      │
│    rx_frames:      bool  (produces FrameMessage batches) │
│    rx_bytes:       bool  (produces raw serial bytes)     │
└──────────────────────────────────────────────────────────┘
```

Both fields are non-optional on `IOCapabilities`. When multiple interfaces are
combined through `IOBroker`, `validate_session_traits()` merges them:
temporal modes must match, protocols are unioned, tx flags are OR'd. Sources
with `multi_source: false` cannot be combined with others.

### Source inventory

| Source            | Module                                   | Temporal  | Protocols     | tx_frames | tx_bytes | multi |
|-------------------|------------------------------------------|-----------|---------------|-----------|----------|-------|
| GVRET (TCP/USB)   | [io/gvret/](../src-tauri/src/io/gvret/)  | realtime  | can, canfd    | ✓         | ✗        | ✓     |
| slcan             | [io/slcan/](../src-tauri/src/io/slcan/)  | realtime  | can, canfd    | ✓/✗       | ✗        | ✓     |
| gs_usb            | [io/gs_usb/](../src-tauri/src/io/gs_usb/)| realtime  | can, canfd    | ✓/✗       | ✗        | ✓     |
| SocketCAN         | [io/socketcan/](../src-tauri/src/io/socketcan/) | realtime | can      | ✓         | ✗        | ✓     |
| Serial (framed)   | [io/serial/](../src-tauri/src/io/serial/)| realtime  | serial¹       | ✗         | ✗        | ✓     |
| Serial (raw)      | [io/serial/](../src-tauri/src/io/serial/)| realtime  | serial        | ✗         | ✓        | ✓     |
| MQTT              | [io/mqtt/](../src-tauri/src/io/mqtt/)    | realtime  | can           | ✗         | ✗        | ✓     |
| Modbus TCP        | [io/modbus_tcp/](../src-tauri/src/io/modbus_tcp/) | realtime | modbus | ✗         | ✗        | ✓     |
| Modbus RTU        | [io/modbus_rtu/](../src-tauri/src/io/modbus_rtu/) | realtime | modbus | ✓         | ✗        | ✓     |
| FrameLink         | [io/framelink/](../src-tauri/src/io/framelink/) | realtime | (per rule) | ✓ | ✗        | ✓     |
| Virtual device    | [io/virtual_device/](../src-tauri/src/io/virtual_device/) | realtime | can\|serial | loopback | loopback | ✓ |
| PostgreSQL        | [io/recorded/postgres.rs](../src-tauri/src/io/recorded/postgres.rs) | recorded | can | ✗ | ✗ | ✗ |
| WireTAP backend   | [io/recorded/backend_api.rs](../src-tauri/src/io/recorded/backend_api.rs) | recorded | can | ✗ | ✗ | ✗ |
| Capture replay    | [io/recorded/capture.rs](../src-tauri/src/io/recorded/capture.rs) | capture | (inherited) | ✗ | ✗ | ✗ |

¹ Framed serial (SLIP, Modbus RTU, delimiter) emits frames, not raw bytes.

---

## 2. Source selection

All sources — hardware devices, databases, recorded sources, and captures — are
selected through a single dialog, [IoSourcePickerDialog](../src/dialogs/IoSourcePickerDialog.tsx).
Clicking the session chip opens the **session menu**; its **Change source** item
opens the picker (with no current source, clicking the chip opens it directly).

```
┌────────────────────────┐   Change source    ┌──────────────────────────┐
│   Session chip + menu   │  ───────────────▶  │  IoSourcePickerDialog    │
│    (SessionControls)    │                    │                          │
└────────────────────────┘                    │  Loads on open:          │
                                              │   • IO profiles          │
                                              │   • Orphaned captures    │
                                              │   • Active sessions      │
                                              │   • Profile usage map    │
                                              │   • Bookmarks            │
                                              └────────┬─────────────────┘
                                                       │
                                     ┌─────────────────┼─────────────────┐
                                     ▼                 ▼                 ▼
                               realtime source   recorded source     pick an active
                               (profile)         (postgres, capture) session to join
```

Action buttons are **trait-driven**. A source with `temporal_mode: "realtime"`
gets `[Connect]`; a `recorded` source gets `[Load]` and `[Connect]`. An
existing session gets `[Join]` / `[Restart]` / `[Resume & Join]`. Joinability
is gated by `InterfaceTraits.multi_source`.

---

## 3. From dialog to backend

```
IoSourcePickerDialog
        │   (Connect / Load / Join / Switch clicked)
        ▼
useIOSourcePickerHandlers
        │   ── onBeforeStart() app cleanup hook
        │   ── merges framing / bus mappings / time bounds
        │   ── routes to manager method
        ▼
useIOSessionManager
        │   watchSource(profileIds[], opts)       unified entry
        │   loadSource(profileIds[], opts)        (recorded ingest)
        │   joinSession(sessionId)
        │   ── generates session ID (see § prefixes)
        │   ── onBeforeWatch callbacks
        │   ── flags: isWatching / isLoading
        ▼
useIOSession              (wraps one sessionStore session for one subscriber)
        │   ── registers unique subscriberId
        │   ── subscribes to WS messages for this session
        │   ── exposes start/stop/pause/resume/seek/leave/reinitialize
        ▼
sessionStore.openSession
```

### Session ID prefixes

Session IDs are independent of profile IDs. Format: `{prefix}_{6-hex}`. The
prefix is **cosmetic** (logs/debugging — nothing parses the id).

| Prefix | Meaning                                                    | Generated in |
|--------|------------------------------------------------------------|--------------|
| `f_`   | realtime + rx_frames (CAN, framed serial, GVRET, gs_usb…)  | Rust `generate_session_id` ([sessions.rs](../src-tauri/src/sessions.rs)) |
| `b_`   | realtime + rx_bytes (raw serial), or capture replay session | Rust (realtime) / `generateCaptureSessionId` (capture) |
| `m_`   | realtime + modbus protocol                                 | Rust `generate_session_id` |
| `s_`   | realtime fallback                                          | Rust `generate_session_id` |
| `t_`   | recorded (PostgreSQL, CSV import)                           | `generateRecordedSessionId` ([useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts)) |

**Realtime** session IDs are generated by Rust: the multi-source watch path calls
the `generate_session_id` command, which infers the prefix from the profiles'
output type (`protocol_for_kind`). The frontend no longer infers it. The
recorded/capture/load fixed prefixes (`t_`/`b_`/`load_`) are still generated by
small frontend helpers (no inference) pending the Phase 4 create-flow consolidation.

Captures have their own immutable `capture_id` (6–8 char random string such
as `xk9m2p`). **The capture ID is not the session ID** — a session replaying
a capture gets a fresh `b_` session ID that owns the capture. See
[capture-flow.md § Identity](capture-flow.md#3-identity).

### `sessionStore.openSession` steps

Defined in [src/stores/sessionStore.ts:711](../src/stores/sessionStore.ts#L711).

1. Check if the session already exists locally (connected) — if so, register
   another subscriber and return.
2. Check if the session exists in the Rust backend via `getIOSessionState`.
3. Destroy any session that was left in `error` state.
4. Create or join:
   - **4a** Backend exists: `registerSessionSubscriber` → read caps/state/capture.
   - **4b** Backend missing: `createIOSession` (or `createCaptureSourceSession`
     for capture replay) then `registerSessionSubscriber`.
5. Subscribe to the session's WebSocket channel and wire message handlers
   (see [§ WebSocket transport](#websocket-transport)). Start the heartbeat
   interval.
6. **Step 5.5** — auto-start playback for recorded sources (PostgreSQL, CSV).
   Capture replay sessions explicitly do **not** auto-start — the user drives
   playback manually. See [sessionStore.ts:992-999](../src/stores/sessionStore.ts#L992-L999).
7. Create/update the `Session` entry in the Zustand store and return.

---

## 4. Rust session lifecycle

A session is an `IOSession` stored in the global `IO_SESSIONS` HashMap in
[src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs). Each session owns a
`Box<dyn IOSource>` plus subscriber metadata, source config, profile bookkeeping,
and capabilities.

Every session eventually becomes a capture (or is torn down). Pause/Play control the
live view; the three **exit controls** in the session menu each end it differently:

```
  Leave session    one app detaches and reviews a frozen capture snapshot;
                   any other apps on the session keep streaming live
  Stop session     the shared source stops → every connected app reviews the
                   same capture
  Destroy session  the session is torn down → every connected app → No Source
```

### Leave session — per-app detach to a snapshot

`handleLeave` ([useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts)) calls the
Rust `session_leave_to_capture` command; the heavy lifting is in
`detach_subscriber_to_capture_copy` ([io/mod.rs](../src-tauri/src/io/mod.rs)):

```
App clicks Leave (realtime/recorded; other apps may share the session)
     │
     ▼
session_leave_to_capture(session_id, subscriber_id)      src-tauri/src/io/mod.rs
     ├─ copy_capture(frame capture) → orphaned snapshot "{capture}_{n}"
     ├─ unregister_subscriber(this subscriber only)
     │     └─ session stays alive if other subscribers remain;
     │        destroyed via the last-subscriber teardown if not
     └─ emit `subscriber-evicted { session_id, subscriber_id, capture_ids }`
                   │
                   ▼
        Only the leaving app's useIOSession receives the event →
        onDestroyed(capture_ids, /*userInitiated*/ false) →
        handleSessionDestroyed switches THIS app to the snapshot replay.
        Any other apps are untouched and keep streaming the live source.
```

The snapshot is a frozen copy — the live session keeps its own capture. Opening the
live capture directly as a replay is deliberately *not* used: `CaptureSource::new`
re-owns (steals) the capture, which would stop the remaining apps persisting frames.
The same `detach_subscriber_to_capture_copy` core backs the Session-Manager's forced
**evict** (it labels the copy `(evicted)` instead of `_{n}`). In capture-replay mode
there's nothing live to leave, so Leave is a plain `session.leave()` disconnect to No
Source. If there are no captured frames, the copy is empty and the app simply returns
to No Source.

### Stop session — stop the shared source for all apps

The **Stop session** control (`stopWatch` → `session_stop_to_capture`) switches the
*whole* session to capture replay in place, so every connected app reviews the same
capture. The realtime-vs-recorded decision and its fallbacks live in Rust: a
**realtime** source stops and switches all listeners to capture (falling back to a
plain `suspend` if no capture exists); a **recorded** source `suspend`s (preserving
position) then switches to capture replay. It emits a scoped `session-lifecycle` so
every subscribed app transitions together (`onSwitchedToCapture`); the frontend just
calls the one command.

### Destroy session (recovery)

The session menu also has a destructive **Destroy session** item for recovering
from a wedged session. It calls `destroy_reader_session(reset: true)`, tearing
down the backend session for *all* subscribers. The deliberate-destroy intent is
carried by Rust in the emitted `session-lifecycle "destroyed"` event (a `reset`
flag on `SessionLifecyclePayload`); the per-app cleanup (`handleSessionDestroyed`)
reads it and resets to **No source** instead of switching to the orphaned capture
(the external-destroy fallback, `reset: false`). Rust owns the intent — there is
no frontend shim.

### Subscriber registration & the one-session invariant

Each session tracks its subscribers in a map on the `IOSession`; the session is
destroyed when its **last** subscriber leaves (`unregister_subscriber`). A
subscriber id is per-`useIOSession`-hook (`appName_<rand>`), and a hook only ever
views one session at a time, so a subscriber must belong to **exactly one**
session.

`register_subscriber` ([io/mod.rs](../src-tauri/src/io/mod.rs)) enforces that
invariant authoritatively: registering a subscriber on a session first removes
that same subscriber id from every *other* session, and any session left with no
subscribers by the move is torn down — the same teardown as a normal
last-subscriber-leaves (stop source, orphan capture, `session-lifecycle
"destroyed"`), factored into a shared `destroy_extracted_session` helper. The
"left" bookkeeping (remove + joiner-count + event) is shared with
`unregister_subscriber` via `remove_subscriber`.

This is the backstop for a frontend leave that loses a race when an app switches
sources (e.g. the Decoder moving from a live Modbus source to a capture replay).
Without it the old session keeps its subscriber and never tears down — left
running and, for a realtime source, polling the device forever — while showing as
a second session bound to the one app. Because the rule lives in Rust (the session
authority) under the `IO_SESSIONS` lock, no frontend timing can orphan a session.

### Play / Pause

Play and Pause are items in the session menu (opened by clicking the session chip).
- **Realtime running** → Pause calls `session.pause()`.
- **Realtime paused** → Play calls `session.resume()`.
- **Capture paused** → Play starts forward playback.
- **Capture running** → Pause pauses playback.

### RESUME to live

`resume_session_to_live` rebuilds the original `IOBroker` from the
stored `source_configs`, calls `profile_tracker::can_use_profile()` for each,
and then uses `replace_session_source(..., auto_start=true)` to swap in the
live reader.

### Capture labelling during streaming

Rename and Pin are session-menu items available whenever capture metadata exists —
including during realtime streaming. Renaming a capture automatically pins
it (marks it persistent). The Speed item is always present but disabled
(greyed) for realtime sessions where speed control is not supported.

### `replace_session_source` — the shared primitive

All three transitions (stop→capture, capture→live, recorded→capture replay) go
through [`replace_session_source`](../src-tauri/src/io/mod.rs#L1920):

1. Stop old device (idempotent — no-op if already stopped).
2. Record old device type.
3. Swap `session.source = new_device`.
4. Update `source_names` / `source_configs` if provided.
5. Clear `suspended_at`.
6. Optionally `start()` the new device.
7. Emit a `session-lifecycle` scoped message containing the new state and
   capabilities so all subscribers pick up the change.

It takes `&mut HashMap<String, IOSession>` rather than the lock itself, so
callers can hold `IO_SESSIONS` across their full operation and avoid
double-locking.

---

## 5. WebSocket transport

Frame delivery and most session events flow over a local WebSocket, not
Tauri events. The server is started during Tauri `setup()` in [lib.rs:945](../src-tauri/src/lib.rs#L945)
and binds to `127.0.0.1:0` (ephemeral port). The frontend fetches the port
and auth token via the Tauri command `get_ws_config` and connects once at
startup through [src/services/wsTransport.ts](../src/services/wsTransport.ts).

### Binary protocol

Each message is a 4-byte header + payload ([ws/protocol.rs](../src-tauri/src/ws/protocol.rs)):

```
┌──────────┬──────────┬──────────┬──────────┬─────────────────┐
│ version+ │ msg_type │ channel  │ reserved │    payload      │
│  flags   │          │ (1 byte) │          │                 │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
  1 byte     1 byte     1 byte     1 byte       variable
```

Channels 1–254 are allocated per subscribed session (one channel per
`sessionId`). Channel 0 is the global broadcast channel for app-wide events.

### Message types

Per-session (channel 1..254):

| MsgType | Value | Purpose |
|---------|-------|---------|
| `FrameData`         | 0x01 | Binary batch of `FrameEnvelope` records |
| `SessionState`      | 0x02 | IO state change (stopped/starting/running/paused/error) |
| `StreamEnded`       | 0x03 | Stream finished with reason + finalised capture info |
| `SessionError`      | 0x04 | Error string |
| `PlaybackPosition`  | 0x05 | timestamp_us / frame_index / frame_count |
| `DeviceConnected`   | 0x06 | A source inside a multi-source session connected |
| `CaptureChanged`    | 0x07 | Capture created/orphaned; frontend re-fetches |
| `SessionLifecycle`  | 0x08 | State + capabilities inline; covers device-replaced, resuming, switched-to-capture |
| `SessionInfo`       | 0x09 | Speed, subscriber count |
| `Reconfigured`      | 0x0A | Session was reconfigured (time range, bookmark) |
| `DecodedSignals`    | 0x14 | JSON batch of decoded signals, pushed alongside `FrameData` when a catalogue is attached (see [§ Decoded-signal stream](#decoded-signal-stream)) |
| `FrameCounts`       | 0x16 | Live total + distinct-(bus,frame_id) unique counts, pushed on the frame cadence (see [§ Frame counts](#frame-counts)) |

Global (channel 0):

| MsgType | Value | Purpose |
|---------|-------|---------|
| `SessionLifecycle`  | 0x08 | Created / destroyed (broadcast to all clients) |
| `TransmitUpdated`   | 0x0B | Transmit queue changes |
| `ReplayState`       | 0x0C | Replay controller state |
| `TestPatternState`  | 0x0D | Test pattern generator state |

Control frames: `Subscribe` / `Unsubscribe` / `SubscribeAck` / `SubscribeNack`,
plus `Heartbeat` and `Auth`. Request/response RPC uses `Command` (0x20) /
`CommandResponse` (0x21) with a correlation id — the `catalog.*` ops below ride
this.

### Decoded-signal stream

Catalogue decoding is done **once, in Rust**, by the shared
[`wiretap-catalog`](../../wiretap-lib-rs) crate — the frontend no longer
re-decodes every frame. Two surfaces, both over this WebSocket:

- **`catalog.*` commands** (request/response via `Command`/`CommandResponse`,
  dispatched in [catalog.rs](../src-tauri/src/catalog.rs) `dispatch_catalog_command`):
  - `catalog.parse` — TOML → resolved `Catalog` model (CAN/Serial/Modbus;
    shorthands + mirror/copy resolved)
  - `catalog.validate` — TOML → `{ valid, errors[] }` (field-path + message)
  - `catalog.import_dbc` / `catalog.export_dbc` — DBC ↔ catalogue TOML
  - `catalog.attach` `{ session_id, content, path? }` — parse + bind a catalogue to
    a session, **returning the resolved `Catalog`** so the caller builds its UI
    model from that one parse; the optional `path` is recorded as the session's
    authoritative decoder path (see below). `catalog.detach` `{ session_id }` — unbind
- **`DecodedSignals` push** (0x14): while a catalogue is attached,
  `send_new_frames` decodes the same batch via `decode_by_id` (applying
  `frame_id_mask`) and pushes a parallel JSON message
  (`[{ frameId, bus, t, signals[], selectors[], headerFields[], sourceAddress }]`).
  `sessionStore` routes it to an `onDecoded` callback (threaded through
  `useIOSession`/`useIOSessionManager`); an app calls `catalog.attach` when it
  loads a catalogue. Because `send_new_frames` only decodes frames *past* a
  forward-only per-session send offset, `catalog.attach` also re-decodes the frames
  already delivered to the client (`redecode_delivered`) and pushes their signals —
  otherwise a catalogue bound *after* a capture replay had already streamed its
  frames (e.g. the per-app Leave switching the decoder to a fresh replay session)
  would leave them showing "No signals decoded". Raw `FrameData` keeps flowing for
  Discovery/Analysis/raw-hex/Calculator. **Decoder and Graph** both
  consume the decoded stream — there is no longer a TypeScript decode engine.
  The Decoder keeps its mirror-validation byte-compare on the raw `FrameData`
  path (it needs the raw bytes + frame timing). Attachments auto-detach on final
  unsubscribe.

Decoding lives entirely in the crate, and so does parsing: the frontend's
`catalogParser.ts` no longer parses TOML — `loadCatalog` calls `catalog.parse`
(Rust) and *adapts* the resolved `Catalog` to the legacy `ParsedCatalog` shape
(camelCase → snake_case) for the Decoder/Graph/Query in-memory models. The
serial header byte-positions (`frame_id_*`, `source_address_*`, `header_fields`)
are derived in the crate at parse time (v0.6.0+), so the adapter just renames
them rather than re-deriving from masks. The Catalog Editor keeps its own TOML
parser ([apps/catalog/toml.ts](../src/apps/catalog/toml.ts)) for round-tripping edits.

For a session-bound app, loading a catalogue parses it **once**: the
[`useSessionCatalog`](../src/hooks/useSessionCatalog.ts) hook (used by Decoder and
Graph) mirrors the session's `catalogPath` into local state, then `attachAndResolve`
(`catalogParser.ts`) calls `catalog.attach` and adapts the returned `Catalog` — so
the same parse binds Rust decode *and* builds the UI model (it falls back to a
model-only `loadCatalog` if attach fails).

The session's `catalogPath` is **Rust-authoritative**: `attachAndResolve` passes the
file path to `catalog.attach`, which records it; `list_active_sessions` reports it as
`catalog_path` and `reconcileKnownSessions` adopts it one-way. Apps mirror it into
local state but must **never write it back** — the dashboard loader doing so (in
`applyParsedCatalog`) raced the mirror into a ~50 ms attach/reload loop.
`setSessionCatalogPath` remains an optimistic local echo that the next reconcile
confirms. Modbus is handled by the Decoder
itself (there is no separate Modbus app): when a Modbus catalogue is involved the
Decoder fetches its poll groups — built in Rust (`catalog.polls`, surfaced on the
resolved catalogue by `catalogParser.ts`; the single source of truth shared with
the MCP/headless open flow) — *before* the watch, via an awaited `onBeforeStart` in
the IO picker that pre-loads the catalogue so the session is created **with** polls in
a single connection (rather than starting pollless and reconnecting, which broke
single-connection devices). A catalogue change mid-stream reinitialises the same
session id with the new polls.

**One-step decoder from the Data Source picker.** The picker
([IoSourcePickerDialog.tsx](../src/dialogs/IoSourcePickerDialog.tsx)) has a Decoder
footer that attaches a catalogue *as the session is created*: the chosen path rides
through `LoadOptions.catalogPath` and `useIOSessionManager` sets it on the new
session via `setSessionCatalogPath` (the cross-app channel), so a decode-aware app's
`useSessionCatalog` mirror then binds it — no second step. It auto-fills from the
selected source's `preferred_catalog`, and when the chosen catalogue declares serial
framing the picker parses it (`loadCatalog`) and reflects that encoding in the
source's framing dropdown, so the framing is explicit before connecting.

**Auto-select from `preferred_catalog`.** When a session is created *without* a
catalogue, the decode-aware apps (Decoder, Dashboard, Query) auto-select one from
the source profile's `preferred_catalog` — building an absolute path with
`buildCatalogPath(preferred, decoderDir)` and setting it via `setSessionCatalogPath`.
The effect waits for `decoderDir` to resolve from settings before running: an empty
dir yields a bare filename, `open_catalog` reads the path verbatim (no dir
resolution) so the attach fails, and the effect's own "already set" guard would then
stop it ever re-running — leaving the session undecoded until a manual pick. Distinct
from the catalog *list* read (which `list_catalogs` resolves dir-side and so does not
gate on `decoderDir`).

**Live serial reframing.** Serial framing (SLIP/Modbus-RTU/delimiter) is applied
by the backend read loop ([io/serial/reader.rs](../src-tauri/src/io/serial/reader.rs)),
so a source connected *before* its catalogue starts in `Raw` mode — raw bytes, no
frames, nothing to decode. Selecting a serial catalogue mid-stream calls the
**`io_set_framing`** command ([transmit.rs](../src-tauri/src/transmit.rs)), which
swaps the running source's framer **in place** via a per-source control channel
(`SourceMessage::ControlReady`, mirroring the transmit path) — same session, no
device reopen, and the attached catalogue keeps decoding (no re-attach). The broker
records a framing override so `combined_capabilities` flips `rx_frames` true (pushed
as a `SessionLifecycle` update), and creates a frame capture on demand (a bytes-only
session has none) so the now-framed messages land, stream and decode. The Decoder
calls it from [`useSessionCatalog`](../src/hooks/useSessionCatalog.ts)'s sibling
serial-config effect when the encoding first appears, falling back to a full
re-watch if the live swap fails.

### Dispatch path

```
IOSource reader task
      │  SourceMessage::Frames
      ▼
IOBroker merge task
      │  sorts by timestamp, batches, writes to capture_store
      ▼
capture_store::append_frames_to_session(session_id, frames)
      │
      │  (reader also calls signal_frames_ready(session_id))
      ▼
signal_throttle.rs — SignalThrottle::should_signal()
      │  SIGNAL_INTERVAL_MS = 500  (2 Hz)
      ▼
ws::dispatch::send_new_frames(session_id)
      ├─ look up WS channel for session_id
      ├─ read new frames from capture_store since last offset
      ├─ encode_frame_batch → binary FrameEnvelope stream → FrameData (0x01)
      ├─ if catalogue attached: decode_frame batch → DecodedSignals (0x14)
      ├─ push live total + unique counts → FrameCounts (0x16)
      └─ send_to_channel
                    │
        ┌───────────┼────────────┬─────────────┐
        ▼           ▼            ▼             ▼
   Discovery    Calculator   (FrameData)   Decoder/Graph
   onFrames     raw bytes      raw          DecodedSignals (decoded in Rust)
```

The 2 Hz throttle lives in [io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs).
Readers write frames into the capture as fast as they arrive; `send_new_frames`
pulls from the capture and pushes to the WS channel at most twice per second.
`SignalThrottle::flush()` is called on stream stop so the final batch is
delivered immediately.

### Frame counts

Frame counts are **Rust-authoritative** — the frontend does not count. Each
capture maintains a running total (`metadata.count`) and an in-memory set of
distinct `(bus, frame_id)` keys ([capture_store.rs](../src-tauri/src/capture_store.rs)),
so total and unique counts are both O(1). `send_new_frames` pushes them on the
2 Hz frame cadence as `FrameCounts` (0x16); they are also surfaced on
`list_active_sessions` (`capture_frame_count` / `capture_unique_frame_count`).
`sessionStore` writes them onto the `Session` (`frameCount` / `uniqueFrameCount`),
and `useIOSessionManager` exposes them for rendering — replacing the old
frontend counting + `isWatching` latch that could stick at 0 after a restart. The
shared session-picker dot (`SessionButton`'s `ActivityDot`) derives a frames/sec rate
from `frameCount` to pulse a sonar ripple in step with bus activity — the dashboard's
old numeric "N frames" readout was dropped in favour of it.

### Subscription lifecycle

1. Frontend sends `Subscribe(sessionId)`.
2. Server's connection manager task allocates a free channel (1..254) and
   records `sessionId → channel` in a shared `CHANNEL_MAP` for non-blocking
   lookup from `dispatch.rs`.
3. Server sends `SubscribeAck{channel}`; frontend wires pending handlers.
4. [`reset_frame_offset`](../src-tauri/src/ws/dispatch.rs#L74) is called so
   the client only receives frames that arrive after subscription.
5. On `Unsubscribe` (or disconnect), the channel refcount drops; if it hits
   zero the channel is released, the frame offset cleared, and any attached
   catalogue detached.

### Reconnect resync

If the WebSocket drops, the transport reconnects with exponential backoff
([wsTransport.ts](../src/services/wsTransport.ts) `scheduleReconnect`). Channel
numbers are invalid after a reconnect, so the server reassigns them via fresh
`SubscribeAck`s. The transport **re-stages the existing per-session handlers**
(keyed by sessionId) before re-subscribing, so they are re-wired to the new
channels — without this the frontend would go deaf to a session the backend still
has alive and the UI would appear frozen. After re-subscribing, the transport
fires `onReconnect` listeners; [`useSessionRosterSync`](../src/hooks/useSessionRosterSync.ts)
uses this (and the global `SessionLifecycle` broadcast) to reconcile against the
backend roster (`list_active_sessions`). Reconciliation refreshes the
authoritative state (`ioState`, capabilities, subscriber count, capture, attached
catalogue path) of sessions the UI already owns — Rust is the source of truth — as
well as adopting
new backend sessions and dropping vanished adopted ones
([sessionRoster.ts](../src/stores/sessionRoster.ts)).

### What still uses Tauri events

Not everything is on WS. These remain Tauri-emitted:

- `session-lifecycle` broadcast of created/destroyed (also mirrored on WS
  global channel).
- `device-probe` — device discovery progress.
- `subscriber-evicted` — when the watchdog kicks a stale subscriber.
- `store:changed` — settings changes.
- `menu-*` — native menu actions.
- `modbus-scan:*` — scanner progress.

### post_session cache

When a session ends, its `StreamEndedInfo`, errors, source info, and
orphaned-capture IDs are written to [io/post_session.rs](../src-tauri/src/io/post_session.rs)
with a 10-second TTL. This exists so a client that unsubscribes in the same
tick a stream ends can still fetch the outcome via command.

---

## 6. Watch vs Load (ingest)

Recorded sources (PostgreSQL, capture) offer two modes. Realtime sources only
support Watch.

```
                    User picks a source
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
      [Connect] Watch                 [Load] Ingest
                                      (recorded only)
            │                               │
            ▼                               ▼
   Frames flow via WS to              Frames counted into capture
   app onFrames callbacks.            (no UI rendering, fast ingest).
   Dialog closes immediately.         Dialog stays open showing progress.
                                      On StreamEnded, auto-switch to
                                      capture replay and close dialog.
```

After a Load the session transitions into capture replay; both paths end with
apps receiving frames through the same `onFrames` callback chain.

---

## 7. Multi-app session sharing

```
┌──────────────┐   watchSource(["gs_usb_1"])
│  Discovery   │──────────────────────┐
└──────────────┘                      │
                                      ▼
                             Session "f_abc123"
                             subscribers: [Discovery]
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌──────────────┐              ┌──────────────┐              ┌──────────────┐
│  Decoder     │              │    Graph     │              │  Transmit    │
│ joinSession  │              │ joinSession  │              │ joinSession  │
│ ("f_abc123") │              │ ("f_abc123") │              │ ("f_abc123") │
└──────────────┘              └──────────────┘              └──────────────┘
                                      │
                             Session "f_abc123"
                             subscribers: [Discovery, Decoder, Graph, Transmit]
                             Frames → all four apps via the same WS channel.
                             Playback position, speed, and state are shared.
                                      │
                         Last subscriber leaves → destroy_session
```

Each app registers a unique `subscriberId`. The Rust side tracks them in
`SessionSubscriber` records and destroys the session when the last one leaves.

---

## 8. Heartbeats, suspension, eviction

Defined in [io/mod.rs:627-633](../src-tauri/src/io/mod.rs#L627-L633):

```
HEARTBEAT_TIMEOUT_SECS          = 30   // subscriber is stale after 30s silence
HEARTBEAT_CHECK_INTERVAL_SECS   = 5    // watchdog runs every 5s
SUSPENSION_GRACE_PERIOD_SECS    = 300  // session survives 5 min with no subscribers
```

Watchdog loop:

```
every 5s:
  for each session:
    for each subscriber:
      if now - last_heartbeat > 30s: remove subscriber
    if session has no subscribers:
      if not yet suspended: pause device, set suspended_at = now
      else if now - suspended_at > 5 min: destroy_session
    if subscriber heartbeats resume: clear suspended_at, device.resume()
```

The 30-second stale threshold (up from 10s) is tuned for WKWebView timer
throttling during display sleep. Frontend heartbeats ride the WebSocket as
`Heartbeat` (0xFE) control frames; if the WS connection is down the frontend
falls back to polling via an `invoke` command.

The WebSocket *connection* itself times out separately, at
`2 × HEARTBEAT_TIMEOUT_SECS` ([ws/server.rs](../src-tauri/src/ws/server.rs)) —
deliberately longer than the subscriber timeout, so the socket outlives a
suspended session and a display-sleep wake resumes on the same connection
without re-subscribing.

### Wake lock

The same watchdog tick runs `update_wake_lock`. The machine is kept awake while
**either** a `Running` session has a live subscriber **or** any capture is
actively recording (`capture_store::has_streaming_captures()` — true while a
capture is in `streaming_ids`). The capture clause matters: closing the last
panel drops the subscribers but the source keeps recording, so the lock must
stay held independent of UI subscribers, otherwise the display sleeps mid-capture
(see WebView recovery below). The lock is released when neither holds, or when
both wake settings (`prevent_idle_sleep`, `keep_display_awake`) are off.

### WebView health probe & recovery (macOS)

While a session has been suspended longer than `PROBE_START_DELAY_SECS`, the
watchdog pings the dashboard webview each tick and expects a `webview_health_pong`
invoke back. After `PROBE_MAX_MISSES` (6) consecutive misses it concludes macOS
has jettisoned the WKWebView content process and triggers recovery: it navigates
the window to the **root URL captured at startup** (`DASHBOARD_ROOT_URL`). It must
*not* read the live `window.url()` here — wry's getter unwraps `URL()` (now
`None`) and panics on the Cocoa main thread, uncatchable from the watchdog task
and fatal to the app; `navigate()` to a known URL string is panic-free and is
what relaunches the content process. Keeping the wake lock held during an active
capture (above) prevents the display sleep that triggers the jettison in the
first place.

---

## 9. Transmit

Both `CanFrame` and `RawBytes` go through the unified `IOSource::transmit`
method using a `TransmitPayload` enum. The Transmit app chooses its view from
`InterfaceTraits.protocols` (frame protocols → `CanTransmitView`, byte
protocols → `SerialTransmitView`) and gates the send itself on
`tx_frames` / `tx_bytes`.

**Interval-driven loops share one cadence.** Repeating transmits (`io_start_repeat_transmit`,
the serial and group variants in [transmit.rs](../src-tauri/src/transmit.rs)) and
Modbus register polling (the poll task in
[io/broker/spawner.rs](../src-tauri/src/io/broker/spawner.rs), and the standalone
[io/modbus_tcp/reader.rs](../src-tauri/src/io/modbus_tcp/reader.rs)) are the same
skeleton — fire immediately, then once per interval, stopping on a cancel flag and
skipping ticks while paused — differing only in the per-tick body (a transmit logs a
`TransmitResult`; a poll emits a `FrameMessage` into the rx stream). That timing
triad lives in one place, `Cadence` ([io/periodic.rs](../src-tauri/src/io/periodic.rs)):
callers write `while cadence.next().await.is_some() { … }`. Modbus RTU keeps its own
sequential scheduler — half-duplex means requests must be strictly ordered, which a
per-task interval can't express.

---

## 10. Key files

### Frontend

| File | Role |
|------|------|
| [src/components/SessionControls.tsx](../src/components/SessionControls.tsx) | Session chip + click-to-open session menu (details, change source, playback, capture actions, disconnect, destroy) |
| [src/dialogs/IoSourcePickerDialog.tsx](../src/dialogs/IoSourcePickerDialog.tsx) | Unified source selection dialog |
| [src/dialogs/io-source-picker/ActionButtons.tsx](../src/dialogs/io-source-picker/ActionButtons.tsx) | Trait-driven action buttons |
| [src/dialogs/io-source-picker/LoadOptions.tsx](../src/dialogs/io-source-picker/LoadOptions.tsx) | Recorded source options (time bounds, speed) |
| [src/dialogs/io-source-picker/FramingOptions.tsx](../src/dialogs/io-source-picker/FramingOptions.tsx) | Serial framing options |
| [src/hooks/useIOSourcePickerHandlers.ts](../src/hooks/useIOSourcePickerHandlers.ts) | Dialog → session manager bridge |
| [src/hooks/useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts) | `watchSource` / `loadSource` / `joinSession` orchestration |
| [src/hooks/useIOSession.ts](../src/hooks/useIOSession.ts) | Per-subscriber session hook |
| [src/hooks/useCaptureSession.ts](../src/hooks/useCaptureSession.ts) | Capture switching helper |
| [src/stores/sessionStore.ts](../src/stores/sessionStore.ts) | Zustand store, `openSession`, WS routing to callbacks |
| [src/services/wsTransport.ts](../src/services/wsTransport.ts) | WebSocket client, subscribe/unsubscribe, message decode |
| [src/api/io.ts](../src/api/io.ts) | `IOCapabilities`, `InterfaceTraits`, `SessionDataStreams` types, Tauri command wrappers |

### Backend

| File | Role |
|------|------|
| [src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs) | `IOSource` trait, `IOSession`, lifecycle, `replace_session_source`, heartbeat watchdog |
| [src-tauri/src/io/traits.rs](../src-tauri/src/io/traits.rs) | `InterfaceTraits`, `SessionDataStreams`, validation/merge |
| [src-tauri/src/io/broker/](../src-tauri/src/io/broker/) | `IOBroker` — source aggregator / merge task |
| [src-tauri/src/io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs) | 2 Hz per-signal rate limiter |
| [src-tauri/src/io/periodic.rs](../src-tauri/src/io/periodic.rs) | `Cadence` — shared interval/cancel/pause primitive for repeat-transmit and Modbus polling |
| [src-tauri/src/io/post_session.rs](../src-tauri/src/io/post_session.rs) | 10 s TTL cache for post-session fetches |
| [src-tauri/src/ws/server.rs](../src-tauri/src/ws/server.rs) | WS server, channel allocation, auth |
| [src-tauri/src/ws/protocol.rs](../src-tauri/src/ws/protocol.rs) | Binary message format, `MsgType`, `encode_frame_batch` |
| [src-tauri/src/ws/dispatch.rs](../src-tauri/src/ws/dispatch.rs) | `send_new_frames`, `send_session_state`, `send_stream_ended`, etc. |
| [src-tauri/src/capture_store.rs](../src-tauri/src/capture_store.rs) | Session-scoped capture registry (see [capture-flow.md](capture-flow.md)) |

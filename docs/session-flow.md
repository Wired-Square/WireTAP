# Session Flow

This document describes how IO sessions are created, joined, driven, and torn
down in WireTAP. It is the canonical reference for the session subsystem.
For capture lifecycle and ownership, see [capture-flow.md](capture-flow.md).

## Architecture layers

```
┌─────────────────────────────────────────────────────────────────┐
│  UI                                                             │
│  SessionButton · IoSourcePickerDialog · SessionActionButtons    │
├─────────────────────────────────────────────────────────────────┤
│  useIOSessionManager        app-level orchestration             │
├─────────────────────────────────────────────────────────────────┤
│  useIOSession               per-listener React hook             │
├─────────────────────────────────────────────────────────────────┤
│  sessionStore               Zustand state, WS message routing   │
├─────────────────────────────────────────────────────────────────┤
│  WebSocket transport        binary frame/event delivery         │
├─────────────────────────────────────────────────────────────────┤
│  Rust backend (io/mod.rs)   IODevice trait, session lifecycle   │
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
│    temporal_mode:  "realtime" | "timeline"               │
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
combined through `MultiSourceReader`, `validate_session_traits()` merges them:
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
| PostgreSQL        | [io/timeline/postgres.rs](../src-tauri/src/io/timeline/postgres.rs) | timeline | can | ✗ | ✗ | ✗ |
| Buffer replay     | [io/timeline/buffer.rs](../src-tauri/src/io/timeline/buffer.rs) | timeline | (inherited) | ✗ | ✗ | ✗ |

¹ Framed serial (SLIP, Modbus RTU, delimiter) emits frames, not raw bytes.

---

## 2. Source selection

All sources — hardware devices, databases, timelines, and buffers — are
selected through a single dialog, [IoSourcePickerDialog](../src/dialogs/IoSourcePickerDialog.tsx).

```
┌────────────────────────┐       click        ┌──────────────────────────┐
│    SessionButton       │  ───────────────▶  │  IoSourcePickerDialog    │
│    (SessionControls)   │                    │                          │
└────────────────────────┘                    │  Loads on open:          │
                                              │   • IO profiles          │
                                              │   • Orphaned buffers     │
                                              │   • Active sessions      │
                                              │   • Profile usage map    │
                                              │   • Bookmarks            │
                                              └────────┬─────────────────┘
                                                       │
                                     ┌─────────────────┼─────────────────┐
                                     ▼                 ▼                 ▼
                               realtime source   recorded source     pick an active
                               (profile)         (postgres, buffer)  session to join
```

Action buttons are **trait-driven**. A source with `temporal_mode: "realtime"`
gets `[Connect]`; a `timeline` source gets `[Load]` and `[Connect]`. An
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
        │   loadSource(profileIds[], opts)        (timeline ingest)
        │   joinSession(sessionId)
        │   ── generates session ID (see § prefixes)
        │   ── onBeforeWatch callbacks
        │   ── flags: isWatching / isLoading
        ▼
useIOSession              (wraps one sessionStore session for one listener)
        │   ── registers unique listenerId
        │   ── subscribes to WS messages for this session
        │   ── exposes start/stop/pause/resume/seek/leave/reinitialize
        ▼
sessionStore.openSession
```

### Session ID prefixes

Session IDs are generated by the frontend and are independent of profile IDs.
Format: `{prefix}_{6-hex}`.

| Prefix | Meaning                                                    | Generated in |
|--------|------------------------------------------------------------|--------------|
| `f_`   | realtime + rx_frames (CAN, framed serial, GVRET, gs_usb…)  | [useIOSessionManager.ts:297-350](../src/hooks/useIOSessionManager.ts#L297-L350) |
| `b_`   | realtime + rx_bytes (raw serial), or buffer replay session | [useIOSessionManager.ts:47-50](../src/hooks/useIOSessionManager.ts#L47-L50), :340 |
| `m_`   | realtime + modbus protocol                                 | :341-342 |
| `s_`   | realtime fallback                                          | :346, :785 |
| `t_`   | timeline (PostgreSQL, CSV import, other recorded)          | [useIOSessionManager.ts:42-45](../src/hooks/useIOSessionManager.ts#L42-L45) |

Captures have their own immutable `capture_id` (6–8 char random string such
as `xk9m2p`). **The capture ID is not the session ID** — a session replaying
a capture gets a fresh `b_` session ID that owns the capture. See
[capture-flow.md § Identity](capture-flow.md#3-identity).

### `sessionStore.openSession` steps

Defined in [src/stores/sessionStore.ts:711](../src/stores/sessionStore.ts#L711).

1. Check if the session already exists locally (connected) — if so, register
   another listener and return.
2. Check if the session exists in the Rust backend via `getIOSessionState`.
3. Destroy any session that was left in `error` state.
4. Create or join:
   - **4a** Backend exists: `registerSessionListener` → read caps/state/capture.
   - **4b** Backend missing: `createIOSession` (or `createCaptureSourceSession`
     for capture replay) then `registerSessionListener`.
5. Subscribe to the session's WebSocket channel and wire message handlers
   (see [§ WebSocket transport](#websocket-transport)). Start the heartbeat
   interval.
6. **Step 5.5** — auto-start playback for timeline sources (PostgreSQL, CSV).
   Capture replay sessions explicitly do **not** auto-start — the user drives
   playback manually. See [sessionStore.ts:992-999](../src/stores/sessionStore.ts#L992-L999).
7. Create/update the `Session` entry in the Zustand store and return.

---

## 4. Rust session lifecycle

A session is an `IOSession` stored in the global `IO_SESSIONS` HashMap in
[src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs). Each session owns a
`Box<dyn IODevice>` plus listener metadata, source config, profile bookkeeping,
and capabilities.

```
                  ┌────────────┐
                  │  RUNNING   │
                  └─────┬──────┘
                        │
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐
  │  PAUSED  │  │ STOP (realtime)│ │ STOPPED │  │ LEAVE         │
  │          │  │ → buffer replay│ │ (timeline)│ │ (last listener)│
  │ resume() │  └───────┬────────┘ └──────────┘  └──────┬───────┘
  │ → RUN    │          │                                │
  └──────────┘          ▼                                ▼
                 ┌────────────────┐            ┌──────────────────┐
                 │ CAPTURE REPLAY │            │ destroy_session  │
                 │ (CaptureSource │            │  (remove from    │
                 │   swapped in)  │            │   IO_SESSIONS)   │
                 └────────────────┘            └──────────────────┘
```

### STOP (realtime source)

```
App clicks STOP
     │
     ▼
stop_and_switch_to_buffer(session_id, speed)       src-tauri/src/io/mod.rs
     ├─ device.stop()                               → emit_stream_ended
     │                                              → finalize_session_captures
     ├─ pick frame capture via get_session_capture_ids
     ├─ mark_capture_active
     ├─ orphan capture from session, release profiles
     ├─ replace_session_device(sessions, id, CaptureSource, …)
     └─ emit session-lifecycle scoped (state+caps) → all listeners
                   │
                   ▼
        Every subscribed app receives the WS SessionLifecycle message
        and transitions to capture replay mode together.
```

`canReturnToLive` becomes true because the original `source_configs` are
retained on the `IOSession`.

### RESUME to live

`resume_session_to_live` rebuilds the original `MultiSourceReader` from the
stored `source_configs`, calls `profile_tracker::can_use_profile()` for each,
and then uses `replace_session_device(..., auto_start=true)` to swap in the
live reader.

### STOP (timeline source)

Timeline sessions (PostgreSQL, buffer) use the existing `suspend_session` /
`switch_to_buffer_replay` pair. Only the initiating app transitions; other
listeners stay on the running session if any remain.

### LEAVE

`session.leave()` unregisters one listener and resets that app's local state.
The session is destroyed only when the **last** listener leaves.

### `replace_session_device` — the shared primitive

All three transitions (stop→buffer, buffer→live, timeline→buffer replay) go
through [`replace_session_device`](../src-tauri/src/io/mod.rs#L1920):

1. Stop old device (idempotent — no-op if already stopped).
2. Record old device type.
3. Swap `session.device = new_device`.
4. Update `source_names` / `source_configs` if provided.
5. Clear `suspended_at`.
6. Optionally `start()` the new device.
7. Emit a `session-lifecycle` scoped message containing the new state and
   capabilities so all listeners pick up the change.

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
| `StreamEnded`       | 0x03 | Stream finished with reason + finalised buffer info |
| `SessionError`      | 0x04 | Error string |
| `PlaybackPosition`  | 0x05 | timestamp_us / frame_index / frame_count |
| `DeviceConnected`   | 0x06 | A source inside a multi-source session connected |
| `BufferChanged`     | 0x07 | Buffer created/orphaned; frontend re-fetches |
| `SessionLifecycle`  | 0x08 | State + capabilities inline; covers device-replaced, resuming, switched-to-buffer |
| `SessionInfo`       | 0x09 | Speed, listener count |
| `Reconfigured`      | 0x0A | Session was reconfigured (time range, bookmark) |

Global (channel 0):

| MsgType | Value | Purpose |
|---------|-------|---------|
| `SessionLifecycle`  | 0x08 | Created / destroyed (broadcast to all clients) |
| `TransmitUpdated`   | 0x0B | Transmit queue changes |
| `ReplayState`       | 0x0C | Replay controller state |
| `TestPatternState`  | 0x0D | Test pattern generator state |

Control frames: `Subscribe` / `Unsubscribe` / `SubscribeAck` / `SubscribeNack`,
plus `Heartbeat` and `Auth`.

### Dispatch path

```
IODevice reader task
      │  SourceMessage::Frames
      ▼
MultiSourceReader merge task
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
      ├─ encode_frame_batch → binary FrameEnvelope stream
      └─ send_to_channel
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
   Discovery    Decoder      Graph
   onFrames     onFrames     onFrames    (via sessionStore callbacks)
```

The 2 Hz throttle lives in [io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs).
Readers write frames into the buffer as fast as they arrive; `send_new_frames`
pulls from the buffer and pushes to the WS channel at most twice per second.
`SignalThrottle::flush()` is called on stream stop so the final batch is
delivered immediately.

### Subscription lifecycle

1. Frontend sends `Subscribe(sessionId)`.
2. Server's connection manager task allocates a free channel (1..254) and
   records `sessionId → channel` in a shared `CHANNEL_MAP` for non-blocking
   lookup from `dispatch.rs`.
3. Server sends `SubscribeAck{channel}`; frontend wires pending handlers.
4. [`reset_frame_offset`](../src-tauri/src/ws/dispatch.rs#L74) is called so
   the client only receives frames that arrive after subscription.
5. On `Unsubscribe` (or disconnect), the channel refcount drops; if it hits
   zero the channel is released and frame offset cleared.

### What still uses Tauri events

Not everything is on WS. These remain Tauri-emitted:

- `session-lifecycle` broadcast of created/destroyed (also mirrored on WS
  global channel).
- `device-probe` — device discovery progress.
- `listener-evicted` — when the watchdog kicks a stale listener.
- `store:changed` — settings changes.
- `menu-*` — native menu actions.
- `modbus-scan:*` — scanner progress.

### post_session cache

When a session ends, its `StreamEndedInfo`, errors, source info, and
orphaned-buffer IDs are written to [io/post_session.rs](../src-tauri/src/io/post_session.rs)
with a 10-second TTL. This exists so a client that unsubscribes in the same
tick a stream ends can still fetch the outcome via command.

---

## 6. Watch vs Load (ingest)

Timeline sources (PostgreSQL, buffer) offer two modes. Realtime sources only
support Watch.

```
                    User picks a source
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
      [Connect] Watch                 [Load] Ingest
                                      (timeline only)
            │                               │
            ▼                               ▼
   Frames flow via WS to              Frames counted into buffer
   app onFrames callbacks.            (no UI rendering, fast ingest).
   Dialog closes immediately.         Dialog stays open showing progress.
                                      On StreamEnded, auto-switch to
                                      buffer replay and close dialog.
```

After a Load the session transitions into buffer replay; both paths end with
apps receiving frames through the same `onFrames` callback chain.

---

## 7. Multi-app session sharing

```
┌──────────────┐   watchSource(["gs_usb_1"])
│  Discovery   │──────────────────────┐
└──────────────┘                      │
                                      ▼
                             Session "f_abc123"
                             listeners: [Discovery]
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
                             listeners: [Discovery, Decoder, Graph, Transmit]
                             Frames → all four apps via the same WS channel.
                             Playback position, speed, and state are shared.
                                      │
                         Last listener leaves → destroy_session
```

Each app registers a unique `listenerId`. The Rust side tracks them in
`SessionListener` records and destroys the session when the last one leaves.

---

## 8. Heartbeats, suspension, eviction

Defined in [io/mod.rs:616-624](../src-tauri/src/io/mod.rs#L616-L624):

```
HEARTBEAT_TIMEOUT_SECS          = 30   // listener is stale after 30s silence
HEARTBEAT_CHECK_INTERVAL_SECS   = 5    // watchdog runs every 5s
SUSPENSION_GRACE_PERIOD_SECS    = 300  // session survives 5 min with no listeners
```

Watchdog loop:

```
every 5s:
  for each session:
    for each listener:
      if now - last_heartbeat > 30s: remove listener
    if session has no listeners:
      if not yet suspended: pause device, set suspended_at = now
      else if now - suspended_at > 5 min: destroy_session
    if listener heartbeats resume: clear suspended_at, device.resume()
```

The 30-second stale threshold (up from 10s) is tuned for WKWebView timer
throttling during display sleep. Frontend heartbeats ride the WebSocket as
`Heartbeat` (0xFE) control frames; if the WS connection is down the frontend
falls back to polling via an `invoke` command.

---

## 9. Transmit

Both `CanFrame` and `RawBytes` go through the unified `IODevice::transmit`
method using a `TransmitPayload` enum. The Transmit app chooses its view from
`InterfaceTraits.protocols` (frame protocols → `CanTransmitView`, byte
protocols → `SerialTransmitView`) and gates the send itself on
`tx_frames` / `tx_bytes`.

---

## 10. Key files

### Frontend

| File | Role |
|------|------|
| [src/components/SessionControls.tsx](../src/components/SessionControls.tsx) | `SessionButton`, `SessionActionButtons`, playback controls |
| [src/dialogs/IoSourcePickerDialog.tsx](../src/dialogs/IoSourcePickerDialog.tsx) | Unified source selection dialog |
| [src/dialogs/io-source-picker/ActionButtons.tsx](../src/dialogs/io-source-picker/ActionButtons.tsx) | Trait-driven action buttons |
| [src/dialogs/io-source-picker/LoadOptions.tsx](../src/dialogs/io-source-picker/LoadOptions.tsx) | Timeline options (time bounds, speed) |
| [src/dialogs/io-source-picker/FramingOptions.tsx](../src/dialogs/io-source-picker/FramingOptions.tsx) | Serial framing options |
| [src/hooks/useIOSourcePickerHandlers.ts](../src/hooks/useIOSourcePickerHandlers.ts) | Dialog → session manager bridge |
| [src/hooks/useIOSessionManager.ts](../src/hooks/useIOSessionManager.ts) | `watchSource` / `loadSource` / `joinSession` orchestration |
| [src/hooks/useIOSession.ts](../src/hooks/useIOSession.ts) | Per-listener session hook |
| [src/hooks/useBufferSession.ts](../src/hooks/useBufferSession.ts) | Buffer switching helper |
| [src/stores/sessionStore.ts](../src/stores/sessionStore.ts) | Zustand store, `openSession`, WS routing to callbacks |
| [src/services/wsTransport.ts](../src/services/wsTransport.ts) | WebSocket client, subscribe/unsubscribe, message decode |
| [src/api/io.ts](../src/api/io.ts) | `IOCapabilities`, `InterfaceTraits`, `SessionDataStreams` types, Tauri command wrappers |

### Backend

| File | Role |
|------|------|
| [src-tauri/src/io/mod.rs](../src-tauri/src/io/mod.rs) | `IODevice` trait, `IOSession`, lifecycle, `replace_session_device`, heartbeat watchdog |
| [src-tauri/src/io/traits.rs](../src-tauri/src/io/traits.rs) | `InterfaceTraits`, `SessionDataStreams`, validation/merge |
| [src-tauri/src/io/multi_source/](../src-tauri/src/io/multi_source/) | `MultiSourceReader` — source aggregator / merge task |
| [src-tauri/src/io/signal_throttle.rs](../src-tauri/src/io/signal_throttle.rs) | 2 Hz per-signal rate limiter |
| [src-tauri/src/io/post_session.rs](../src-tauri/src/io/post_session.rs) | 10 s TTL cache for post-session fetches |
| [src-tauri/src/ws/server.rs](../src-tauri/src/ws/server.rs) | WS server, channel allocation, auth |
| [src-tauri/src/ws/protocol.rs](../src-tauri/src/ws/protocol.rs) | Binary message format, `MsgType`, `encode_frame_batch` |
| [src-tauri/src/ws/dispatch.rs](../src-tauri/src/ws/dispatch.rs) | `send_new_frames`, `send_session_state`, `send_stream_ended`, etc. |
| [src-tauri/src/capture_store.rs](../src-tauri/src/capture_store.rs) | Session-scoped capture registry (see [capture-flow.md](capture-flow.md)) |

# WebSocket Binary Transport Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all Rust→JS push communication with a local WebSocket server using binary frames, eliminating the ~8 MB/min WebKit malloc growth caused by Tauri's evaluate_script and ipc:// response paths.

**Architecture:** Rust spawns a tokio-tungstenite WebSocket server on localhost at app start. Frontend connects, authenticates, and subscribes to session channels. All frame data and session events are pushed as binary messages. JS→Rust commands stay on Tauri invoke.

**Tech Stack:** Rust (tokio-tungstenite, tokio), TypeScript (native WebSocket API, DataView)

---

## Spec

`docs/superpowers/specs/2026-03-16-websocket-binary-transport-design.md`

## File Map

### New Rust Files

| File | Responsibility |
|------|---------------|
| `src-tauri/src/ws/mod.rs` | Module root — re-exports |
| `src-tauri/src/ws/protocol.rs` | Binary message encoding: header, message types, frame envelope, CAN frame definitions |
| `src-tauri/src/ws/server.rs` | WebSocket server: TCP listener, auth, connection lifecycle, fan-out to subscribers |
| `src-tauri/src/ws/dispatch.rs` | Bridge from IO session system to WebSocket: replaces emit_to_session calls, channel multiplexing, batching |

### New Frontend Files

| File | Responsibility |
|------|---------------|
| `src/services/wsProtocol.ts` | Binary message decoding: header parsing, frame data parsing with DataView |
| `src/services/wsTransport.ts` | WebSocket connection lifecycle: connect, auth, reconnect, subscribe/unsubscribe, message dispatch to sessionStore callbacks |

### Modified Files

| File | Changes |
|------|---------|
| `src-tauri/Cargo.toml` | Add `tokio-tungstenite` dependency |
| `src-tauri/src/lib.rs` | Spawn WS server in `setup()`, register `get_ws_config` command |
| `src-tauri/src/io/mod.rs` | Emit helpers route through `ws::dispatch` instead of `emit_to_session` for session-scoped events |
| `src/stores/sessionStore.ts` | `setupSessionEventListeners` uses WS transport instead of Tauri `listen` calls |
| `src/WireTAP.tsx` | Establish WS connection on app startup after settings load |

---

## Chunk 1: Rust Binary Protocol

### Task 1: Protocol Message Types and Header Encoding

**Files:**
- Create: `src-tauri/src/ws/mod.rs`
- Create: `src-tauri/src/ws/protocol.rs`

- [ ] **Step 1: Create module structure**

Create `src-tauri/src/ws/mod.rs`:
```rust
pub mod protocol;
```

Add `mod ws;` to `src-tauri/src/main.rs` or `src-tauri/src/lib.rs` (wherever modules are declared).

- [ ] **Step 2: Define message types and header encoding with tests**

Create `src-tauri/src/ws/protocol.rs` with:

- `PROTOCOL_VERSION: u8 = 1`
- `HEADER_SIZE: usize = 4`
- `MsgType` enum (u8 repr): `FrameData=0x01, SessionState=0x02, StreamEnded=0x03, SessionError=0x04, PlaybackPosition=0x05, DeviceConnected=0x06, BufferChanged=0x07, SessionLifecycle=0x08, SessionInfo=0x09, Reconfigured=0x0A, TransmitUpdated=0x0B, ReplayState=0x0C, Subscribe=0x10, Unsubscribe=0x11, SubscribeAck=0x12, SubscribeNack=0x13, Heartbeat=0xFE, Auth=0xFF`
- `Header` struct: `version_flags: u8, msg_type: MsgType, channel: u8, reserved: u8`
- `Header::encode(&self) -> [u8; 4]` — serialise to 4 bytes
- `Header::decode(bytes: &[u8]) -> Result<Header, ProtocolError>` — parse from 4 bytes
- `encode_message(msg_type: MsgType, channel: u8, payload: &[u8]) -> Vec<u8>` — header + payload
- Unit tests: round-trip encode/decode, version nibble, invalid message type

- [ ] **Step 3: Run tests**

```bash
cd src-tauri && cargo test ws::protocol -- --nocapture
```

- [ ] **Step 4: Commit**

### Task 2: Frame Data Binary Encoding

**Files:**
- Modify: `src-tauri/src/ws/protocol.rs`

- [ ] **Step 1: Define frame type identifiers and envelope encoding**

Add to `protocol.rs`:

- `FrameType` enum (u16 repr): `Can=0x0001, CanFd=0x0002, Modbus=0x0003, Serial=0x0004`
- `encode_frame_envelope(timestamp_us: u64, bus: u8, frame_type: FrameType, data: &[u8]) -> Vec<u8>` — 12-byte header + data
- `decode_frame_envelope(bytes: &[u8]) -> Result<(FrameEnvelope, &[u8] /* remaining */), ProtocolError>` — parse one frame, return remaining bytes
- `FrameEnvelope` struct: `timestamp_us: u64, bus: u8, frame_type: FrameType, len: u8, data: Vec<u8>`

- [ ] **Step 2: Define CAN frame encoding within data**

Add to `protocol.rs`:

- `encode_can_frame(frame_id: u32, is_extended: bool, is_rtr: bool, direction_tx: bool, payload: &[u8]) -> Vec<u8>` — packs id_flags (u32 LE) + payload bytes
- `decode_can_frame(data: &[u8]) -> Result<CanFrame, ProtocolError>` — extracts id, flags, payload
- `CanFrame` struct: `id: u32, is_extended: bool, is_rtr: bool, direction_tx: bool, payload: Vec<u8>`
- Same for CAN-FD: `encode_canfd_frame` / `decode_canfd_frame` with `brs` flag instead of `is_rtr`

- [ ] **Step 3: Batch encoding from FrameMessage**

Add conversion from the existing `FrameMessage` struct:

- `encode_frame_batch(frames: &[FrameMessage]) -> Vec<u8>` — encodes a vector of FrameMessage into a contiguous byte buffer (envelope + CAN/serial data for each)
- Maps `FrameMessage.protocol` string → `FrameType` enum
- Maps `FrameMessage.is_fd` → choose CAN vs CAN-FD encoding
- Maps `FrameMessage.direction` → direction bit in id_flags
- For Serial type: data is raw `FrameMessage.bytes`, no inner structure

- [ ] **Step 4: Unit tests for frame encoding**

Test cases:
- Round-trip encode/decode for CAN 2.0 (11-bit ID, 29-bit extended)
- Round-trip for CAN-FD (64-byte payload, BRS flag)
- Round-trip for Serial (raw bytes)
- Batch encoding of mixed frame types
- Empty batch (0 frames)
- Edge case: DLC=0 (no payload)

- [ ] **Step 5: Run tests, commit**

```bash
cd src-tauri && cargo test ws::protocol -- --nocapture
```

### Task 3: Non-Frame Message Encoding

**Files:**
- Modify: `src-tauri/src/ws/protocol.rs`

- [ ] **Step 1: Encode/decode helpers for each non-frame message type**

Add to `protocol.rs`:

- `encode_session_state(state: &IOState) -> Vec<u8>` — state enum as u8 + optional error string
- `encode_stream_ended(info: &StreamEndedInfo) -> Vec<u8>` — reason u8 + buffer metadata
- `encode_session_error(error: &str) -> Vec<u8>` — UTF-8 bytes
- `encode_playback_position(timestamp_us: u64, frame_index: u32, frame_count: u32) -> Vec<u8>` — fixed 16 bytes
- `encode_device_connected(device_type: &str, address: &str, bus: Option<u8>) -> Vec<u8>` — length-prefixed UTF-8 strings
- `encode_buffer_changed(buffer_id: &str) -> Vec<u8>` — length-prefixed UTF-8
- `encode_session_lifecycle(event_type: &str, session_id: &str, device_type: Option<&str>, state: Option<&str>) -> Vec<u8>`
- `encode_session_info(speed: f64, listener_count: u16) -> Vec<u8>` — fixed 10 bytes
- `encode_subscribe_ack(channel: u8, session_id: &str) -> Vec<u8>`
- `encode_subscribe_nack(error: &str) -> Vec<u8>`

For length-prefixed UTF-8 strings: `[u16 LE length][UTF-8 bytes]`

- [ ] **Step 2: Unit tests for non-frame messages**

- [ ] **Step 3: Run tests, commit**

---

## Chunk 2: Rust WebSocket Server

### Task 4: WebSocket Server Core

**Files:**
- Create: `src-tauri/src/ws/server.rs`
- Modify: `src-tauri/src/ws/mod.rs`

- [ ] **Step 1: Define server state types**

In `server.rs`:
- `WsServer` struct: holds `port: u16`, `token: String`, `connections: Arc<RwLock<HashMap<usize, WsConnection>>>`, `channel_map: Arc<RwLock<ChannelMap>>`
- `WsConnection` struct: holds `sender: SplitSink<WebSocketStream<TcpStream>, Message>`, `authenticated: bool`, `subscribed_channels: HashSet<u8>`
- `ChannelMap` struct: maps session_id ↔ channel number, tracks next available channel
- Global `WS_SERVER: OnceLock<WsServer>` for access from emit helpers

- [ ] **Step 2: Implement server startup**

- `WsServer::start() -> Result<(u16, String), Error>` — bind to `127.0.0.1:0` (random port), generate random token (32 hex chars), spawn accept loop, return `(port, token)`
- Accept loop: for each incoming TCP connection, upgrade to WebSocket, spawn connection handler task
- Connection handler: read messages, validate auth, handle subscribe/unsubscribe, heartbeat

- [ ] **Step 3: Implement auth flow**

- On connection: set `authenticated = false`
- First message must be `Auth` with correct token, check `Origin` header from HTTP upgrade
- If auth fails: close connection with error
- If auth succeeds: set `authenticated = true`

- [ ] **Step 4: Implement subscribe/unsubscribe**

- `Subscribe` message: extract session_id from payload, allocate channel via ChannelMap, send `SubscribeAck` with channel + session_id back to the subscribing connection
- `Unsubscribe` message: release channel, remove from connection's subscribed_channels
- Channel exhaustion: send `SubscribeNack` if all 254 channels used

- [ ] **Step 5: Implement send_to_channel**

- `WsServer::send_to_channel(channel: u8, data: Vec<u8>)` — iterate all connections, send to those subscribed to this channel
- `WsServer::send_global(data: Vec<u8>)` — send to all authenticated connections (channel 0)
- Both methods: skip connections with full send buffers (non-blocking), log dropped messages

- [ ] **Step 6: Implement heartbeat**

- Server sends `Heartbeat` every 30s to all authenticated connections
- If a connection doesn't respond within 60s, close it

- [ ] **Step 7: Implement connection cleanup**

- On WebSocket close: remove from connections map, release all subscribed channels
- On app shutdown: close all connections, stop accept loop

- [ ] **Step 8: Build, commit**

```bash
cd src-tauri && cargo build --lib
```

### Task 5: App Integration — Server Startup and Config Command

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/ws/mod.rs`

- [ ] **Step 1: Add dependency**

Add to `Cargo.toml`:
```toml
tokio-tungstenite = "0.26"
```

- [ ] **Step 2: Add get_ws_config command**

In `lib.rs` or a new file, add:
```rust
#[tauri::command(rename_all = "snake_case")]
pub fn get_ws_config() -> Result<WsConfig, String> {
    // Read from WS_SERVER global
}

#[derive(Serialize)]
pub struct WsConfig {
    pub port: u16,
    pub token: String,
}
```

Register in `generate_handler![...]`.

- [ ] **Step 3: Spawn server in setup()**

In `lib.rs` `.setup()` closure, after heartbeat watchdog start (line ~912):
```rust
let (ws_port, ws_token) = ws::server::start().map_err(|e| e.to_string())?;
// Store in global state for get_ws_config command
```

- [ ] **Step 4: Build and test startup**

```bash
cd src-tauri && cargo build --lib
```

- [ ] **Step 5: Commit**

---

## Chunk 3: Rust Dispatch Bridge

### Task 6: WebSocket Dispatch — Bridge from IO to WebSocket

**Files:**
- Create: `src-tauri/src/ws/dispatch.rs`
- Modify: `src-tauri/src/ws/mod.rs`
- Modify: `src-tauri/src/io/mod.rs`

- [ ] **Step 1: Create dispatch functions**

In `dispatch.rs`, create functions that mirror the existing emit helpers but send via WebSocket:

```rust
pub fn send_frames(session_id: &str, frames: &[FrameMessage]) {
    let server = match WS_SERVER.get() { Some(s) => s, None => return };
    let channel = match server.channel_for_session(session_id) { Some(c) => c, None => return };
    let payload = protocol::encode_frame_batch(frames);
    let msg = protocol::encode_message(MsgType::FrameData, channel, &payload);
    server.send_to_channel(channel, msg);
}

pub fn send_session_state(session_id: &str, state: &IOState) { ... }
pub fn send_stream_ended(session_id: &str, info: &StreamEndedInfo) { ... }
pub fn send_session_error(session_id: &str, error: &str) { ... }
pub fn send_playback_position(session_id: &str, pos: &PlaybackPosition) { ... }
pub fn send_device_connected(session_id: &str, device_type: &str, address: &str, bus: Option<u8>) { ... }
pub fn send_buffer_changed(session_id: &str) { ... }
pub fn send_session_lifecycle(payload: &SessionLifecyclePayload) { ... }
pub fn send_session_info(session_id: &str, speed: f64, listener_count: u16) { ... }
pub fn send_reconfigured(session_id: &str) { ... }
pub fn send_transmit_updated() { ... }
pub fn send_replay_state(state: &ReplayState) { ... }
```

Each function: encode payload → wrap in message → send to channel (or global for lifecycle/transmit/replay).

- [ ] **Step 2: Update emit helpers in io/mod.rs**

For each emit helper, add a `ws::dispatch` call. The existing `emit_to_session` / `app.emit` calls are kept temporarily (dual-path) so the system works during incremental migration. Example:

```rust
pub fn emit_state_change(app: &AppHandle, session_id: &str, _previous: &IOState, current: &IOState) {
    emit_to_session(app, "session-changed", session_id, ());
    ws::dispatch::send_session_state(session_id, current);
}
```

For frame data — the signal_frames_ready path changes. Currently drivers store frames in buffer_store then signal. With WebSocket, drivers should ALSO pass the frames to `ws::dispatch::send_frames` at the same throttle cadence. The `SignalThrottle` batch timer in each driver becomes the WebSocket batch timer.

Update `signal_frames_ready` to accept frames:
```rust
pub fn signal_frames_ready(app: &AppHandle, session_id: &str, frames: &[FrameMessage]) {
    emit_to_session(app, "frames-ready", session_id, ());  // keep for now
    ws::dispatch::send_frames(session_id, frames);
}
```

This requires updating all call sites in drivers (merge.rs, nusb_driver.rs, etc.) to pass frames to `signal_frames_ready`. Currently they store frames in buffer_store then call `signal_frames_ready()` with no frame argument.

**Alternative (simpler):** Instead of passing frames through, have `ws::dispatch::send_frames` read from buffer_store at the throttle cadence — same as the frontend currently does. This avoids changing driver call sites. The dispatch module maintains a `last_sent_offset` per session and fetches the delta from buffer_store.

- [ ] **Step 3: Build, commit**

### Task 7: Frame Data Dispatch from Buffer Store

**Files:**
- Modify: `src-tauri/src/ws/dispatch.rs`

- [ ] **Step 1: Implement offset-based frame delivery**

Instead of passing frames through the signal path, dispatch reads from buffer_store:

```rust
static FRAME_OFFSETS: Lazy<RwLock<HashMap<String, usize>>> = ...;

pub fn send_new_frames(session_id: &str) {
    let server = match WS_SERVER.get() { ... };
    let channel = match server.channel_for_session(session_id) { ... };

    let offset = FRAME_OFFSETS.read().ok()
        .and_then(|m| m.get(session_id).copied())
        .unwrap_or(0);

    let frames = buffer_store::get_frames_from_offset(session_id, offset, 500);
    if frames.is_empty() { return; }

    let new_offset = offset + frames.len();
    FRAME_OFFSETS.write().ok().map(|mut m| m.insert(session_id.to_string(), new_offset));

    let payload = protocol::encode_frame_batch(&frames);
    let msg = protocol::encode_message(MsgType::FrameData, channel, &payload);
    server.send_to_channel(channel, msg);
}
```

Note: `buffer_store::get_frames_from_offset` may need to be added — a paginated read from a starting offset. Check if `get_buffer_frames_paginated` can serve this purpose.

- [ ] **Step 2: Hook into signal_frames_ready**

```rust
pub fn signal_frames_ready(app: &AppHandle, session_id: &str) {
    emit_to_session(app, "frames-ready", session_id, ());  // keep for now
    ws::dispatch::send_new_frames(session_id);
}
```

No driver call site changes needed — same signature.

- [ ] **Step 3: Reset offset on session subscribe/destroy**

- On `Subscribe`: set offset to current buffer count (start from current position)
- On `Unsubscribe` / session destroy: remove from FRAME_OFFSETS

- [ ] **Step 4: Build, commit**

---

## Chunk 4: Frontend Binary Protocol

### Task 8: Frontend Protocol Decoder

**Files:**
- Create: `src/services/wsProtocol.ts`

- [ ] **Step 1: Define constants and types**

```typescript
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 4;

export const MsgType = {
  FrameData: 0x01,
  SessionState: 0x02,
  StreamEnded: 0x03,
  SessionError: 0x04,
  PlaybackPosition: 0x05,
  DeviceConnected: 0x06,
  BufferChanged: 0x07,
  SessionLifecycle: 0x08,
  SessionInfo: 0x09,
  Reconfigured: 0x0A,
  TransmitUpdated: 0x0B,
  ReplayState: 0x0C,
  Subscribe: 0x10,
  Unsubscribe: 0x11,
  SubscribeAck: 0x12,
  SubscribeNack: 0x13,
  Heartbeat: 0xFE,
  Auth: 0xFF,
} as const;

export const FrameType = {
  Can: 0x0001,
  CanFd: 0x0002,
  Modbus: 0x0003,
  Serial: 0x0004,
} as const;
```

- [ ] **Step 2: Header and message encoding/decoding**

```typescript
export function encodeMessage(msgType: number, channel: number, payload?: Uint8Array): ArrayBuffer
export function decodeHeader(buf: ArrayBuffer): { version: number; flags: number; msgType: number; channel: number }
```

- [ ] **Step 3: Frame data decoding**

```typescript
export function decodeFrameBatch(payload: Uint8Array): FrameMessage[]
```

Uses `DataView` for zero-copy parsing. Iterates through the payload consuming 12-byte envelopes + variable `len` bytes of data. For CAN/CAN-FD types, extracts `id_flags` and decomposes into `frame_id`, `is_extended`, `is_rtr`/`brs`, `direction`.

Returns `FrameMessage[]` matching the existing TypeScript type so downstream callbacks work unchanged.

- [ ] **Step 4: Non-frame message decoding**

Decode functions for each message type that extracts the payload into the appropriate TypeScript types (IOState, StreamEndedInfo, PlaybackPosition, etc.).

- [ ] **Step 5: Subscribe/Auth message encoding**

```typescript
export function encodeAuth(token: string): ArrayBuffer
export function encodeSubscribe(sessionId: string): ArrayBuffer
export function encodeUnsubscribe(channel: number): ArrayBuffer
export function encodeHeartbeat(): ArrayBuffer
```

- [ ] **Step 6: Unit tests**

Test with known binary payloads: encode on one side, decode on the other. Verify round-trip for all message types. Test edge cases: empty payloads, max-length strings, 64-byte CAN-FD frames.

Use vitest (already configured in the project).

- [ ] **Step 7: Commit**

### Task 9: Frontend WebSocket Transport Service

**Files:**
- Create: `src/services/wsTransport.ts`
- Modify: `src/WireTAP.tsx`

- [ ] **Step 1: Create WS transport with connection lifecycle**

```typescript
class WsTransport {
  private ws: WebSocket | null = null;
  private channelMap: Map<number, string> = new Map();  // channel → sessionId
  private sessionMap: Map<string, number> = new Map();  // sessionId → channel
  private onMessage: Map<number, Map<number, (payload: Uint8Array) => void>> = new Map();  // channel → msgType → handler

  async connect(port: number, token: string): Promise<void>
  disconnect(): void
  subscribe(sessionId: string): Promise<number>  // returns channel
  unsubscribe(sessionId: string): void
  onSessionMessage(sessionId: string, msgType: number, handler: (payload: Uint8Array) => void): () => void  // returns unsubscribe fn
  onGlobalMessage(msgType: number, handler: (payload: Uint8Array) => void): () => void
}
```

- [ ] **Step 2: Implement connection and auth**

- `connect()`: creates WebSocket, sets `binaryType = 'arraybuffer'`, sends Auth message, waits for first message (or timeout)
- `onclose` handler: attempt reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- On reconnect: re-authenticate (token stays valid), re-subscribe all active channels

- [ ] **Step 3: Implement message dispatch**

- `ws.onmessage`: decode header, look up channel in channelMap, dispatch to registered handlers
- For `SubscribeAck`: update channelMap/sessionMap, resolve the subscribe Promise
- For `Heartbeat`: respond with Heartbeat

- [ ] **Step 4: Create global singleton and startup hook**

```typescript
export const wsTransport = new WsTransport();

export async function initWsTransport(): Promise<void> {
  const { port, token } = await invoke<WsConfig>("get_ws_config");
  await wsTransport.connect(port, token);
}
```

- [ ] **Step 5: Hook into WireTAP.tsx startup**

In `WireTAP.tsx`, after settings are loaded:
```typescript
useEffect(() => {
  if (settingsLoaded) {
    initWsTransport().catch(console.error);
  }
}, [settingsLoaded]);
```

- [ ] **Step 6: Build, commit**

---

## Chunk 5: Frontend Integration

### Task 10: Replace sessionStore Listeners with WebSocket

**Files:**
- Modify: `src/stores/sessionStore.ts`

This is the largest frontend task. The entire `setupSessionEventListeners` function switches from Tauri `listen` calls to WS transport handlers.

- [ ] **Step 1: Add WS subscribe/unsubscribe to session lifecycle**

When a session's event listeners are set up, subscribe to its WS channel:
```typescript
const channel = await wsTransport.subscribe(sessionId);
```

When cleaning up:
```typescript
wsTransport.unsubscribe(sessionId);
```

- [ ] **Step 2: Replace frames-ready listener**

Replace the `listen("frames-ready:${sessionId}", ...)` block with:
```typescript
wsTransport.onSessionMessage(sessionId, MsgType.FrameData, (payload) => {
  const frames = decodeFrameBatch(payload);
  if (frames.length > 0) {
    invokeCallbacks(eventListeners, "onFrames", frames);
  }
});
```

No invoke call, no offset tracking — frames arrive pre-decoded from the binary stream.

- [ ] **Step 3: Replace all other session-scoped listeners**

For each signal currently in `setupSessionEventListeners`:

| Old listener | New WS handler | Decodes to |
|-------------|---------------|------------|
| `session-changed` | `MsgType.SessionState` | IOState → update ioState |
| `stream-ended` | `MsgType.StreamEnded` | StreamEndedInfo → update buffer state, fire callback |
| `session-error` | `MsgType.SessionError` | String → fire onError callback |
| `playback-position` | `MsgType.PlaybackPosition` | Position → update playbackPosition |
| `bytes-ready` | `MsgType.FrameData` (Serial type) | Frames → fire onBytes callback |
| `buffer-changed` | `MsgType.BufferChanged` | Buffer ID → fetch metadata via invoke |
| `session-reconfigured` | `MsgType.Reconfigured` | Empty → fire callback |
| `session-info` | `MsgType.SessionInfo` | Speed + count → update session |
| `session-lifecycle` | `MsgType.SessionLifecycle` (scoped) | State → update session, fire callback |

Each WS handler directly decodes the binary payload and calls the same `invokeCallbacks` or `updateSession` functions. No invoke fetch needed — the data is in the message.

- [ ] **Step 4: Replace global listeners**

Move global event listeners to WS:
- `TransmitUpdated` (0x0B) → replace `transmit-updated` listener in `useTransmitHistorySubscription.ts`
- `ReplayState` (0x0C) → replace `replay-lifecycle` / `replay-progress` listeners
- `SessionLifecycle` (0x08) on channel 0 → replace global `session-lifecycle` listener

- [ ] **Step 5: Remove Tauri listen imports and cleanup**

Remove `listen` imports from `@tauri-apps/api/event` where no longer needed. Remove the signal-then-fetch `invoke` wrappers that are no longer called (getStreamEndedInfo, getSessionError, getPlaybackPosition, etc.).

- [ ] **Step 6: Build frontend**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

### Task 11: Remove Dual-Path Tauri Events

**Files:**
- Modify: `src-tauri/src/io/mod.rs`
- Modify: `src-tauri/src/transmit.rs`
- Modify: `src-tauri/src/replay.rs`

Once the frontend is fully on WebSocket:

- [ ] **Step 1: Remove emit_to_session calls from emit helpers**

The emit helpers currently call both `emit_to_session` (Tauri events) and `ws::dispatch` (WebSocket). Remove the `emit_to_session` calls, keeping only the WS dispatch path.

- [ ] **Step 2: Remove global app.emit calls**

In `transmit.rs`: remove `app.emit("transmit-updated", ())` calls — replaced by `ws::dispatch::send_transmit_updated()`.

In `replay.rs`: remove `app.emit("replay-lifecycle", ...)` and `app.emit("replay-progress", ...)` calls — replaced by `ws::dispatch::send_replay_state(...)`.

- [ ] **Step 3: Remove emit_to_session function**

The function is no longer needed. Remove it from `io/mod.rs`. Also remove the `log_emit_rate` diagnostic counter (no longer relevant).

Keep the `is_session_closing` check — move it into `ws::dispatch` functions.

- [ ] **Step 4: Remove signal_frames_ready and signal_bytes_ready**

Replace with direct calls to `ws::dispatch::send_new_frames` in drivers. Or keep as thin wrappers that only call dispatch.

- [ ] **Step 5: Clean up unused imports and dead code**

Remove `FrameBatchPayload`, `StateChangePayload`, and other payload structs that are no longer serialised. Remove the signal-then-fetch invoke commands (`get_stream_ended_info`, `get_session_error`, `get_playback_position`, `get_session_sources`) and their registrations in `lib.rs`. Keep `get_ws_config` and any commands still used by the frontend.

- [ ] **Step 6: Build both, commit**

```bash
cd src-tauri && cargo build --lib && cd .. && npx tsc --noEmit
```

---

## Chunk 6: Verification

### Task 12: End-to-End Testing and Memory Verification

- [ ] **Step 1: Functional test**

Start the app, connect devices, stream:
1. Discovery: connect 2 CAN interfaces, verify frames appear
2. Transmit: send repeat frames at 1Hz, verify history updates
3. Playback: open a buffer, play/pause/seek, verify position updates
4. Stop: verify stream-ended notification, buffer metadata correct
5. Multi-session: run discovery + transmit simultaneously

- [ ] **Step 2: Memory footprint test**

Run `footprint <pid> --sample 60 --sample-duration 3600` during sustained streaming. Target: WebKit malloc stays flat (within ~10% of idle baseline after initial ramp).

- [ ] **Step 3: Check tlog for WS diagnostics**

Verify no Tauri event emissions on hot paths. All frame data flows through WebSocket.

- [ ] **Step 4: Cross-platform build**

```bash
npm run tauri build  # macOS
# Test on Windows and Linux if available
```

- [ ] **Step 5: Final commit**

---

## Implementation Notes

### Incremental Migration

The plan uses a dual-path approach (Tasks 6-10): both Tauri events AND WebSocket run in parallel during development. This means the app works at every commit — if WebSocket fails, Tauri events still deliver data. Task 11 removes the Tauri path once WebSocket is verified.

### Buffer Store Integration

The dispatch module reads frames from `buffer_store` at the throttle cadence rather than receiving them from drivers. This avoids changing every driver's call sites. The tradeoff is a buffer_store read per batch, but this is SQLite-backed and the reads are indexed — negligible overhead.

### Bytes as Frames

Per the design discussion, serial bytes are frames with `type=0x0004` (Serial). No separate bytes path needed. The `onBytes` callback receives `FrameMessage[]` with `protocol: "serial"`, same as any other frame type. The frontend can distinguish by checking `frame_type`.

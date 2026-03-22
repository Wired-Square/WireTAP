# WebSocket Binary Transport Design

## Problem

WireTAP's WebView memory grows at ~8 MB/min during active streaming. Root cause: every Rust-to-JS communication path in Tauri uses script evaluation (events, channels) or creates per-request networking objects in WebKit's URL scheme handler (ipc:// invoke responses). Both paths allocate non-reclaimable WebKit malloc memory.

**Evidence:**
- Idle baseline: WebView memory flat at ~87 MB (zero growth)
- Streaming with signal-then-fetch (2 script-eval/sec + ~10 invoke/sec): +8.2 MB/min
- Tauri events: every `app.emit()` evaluates a script string — creates compiled code blocks
- Tauri channels: every `channel.send()` evaluates a script string — same problem
- Tauri invoke responses: each ipc:// round-trip creates NSHTTPURLResponse + NSData objects that accumulate

## Solution

Replace all Rust-to-JS push communication with a local WebSocket server. WebSocket is handled by the browser's native networking stack — no script evaluation, no custom protocol handlers, no per-request object allocation. Binary frames delivered as `ArrayBuffer` to `onmessage` callbacks through the standard JavaScript event loop.

JS-to-Rust commands (create session, start/stop, transmit, seek, etc.) remain as Tauri `invoke` calls. These are infrequent and request/response — invoke is the right tool.

## Architecture

### Transport Layer

A single WebSocket server starts when the Tauri app launches:

1. Bind to `127.0.0.1` on a random available port
2. Frontend retrieves the port and auth token via `invoke("get_ws_config")` → `{ port, token }`
3. Each WebView window connects: `new WebSocket('ws://127.0.0.1:PORT')`
4. Each connection authenticates by sending an `Auth` message with the token
5. All connections are multiplexed — each subscribes to the session channels it needs

**Dependencies:** `tokio-tungstenite` (already in the async Tokio ecosystem used by the app).

### Security

- Bound to `127.0.0.1` only — not reachable from the network
- Auth token generated at server start, passed to frontend via invoke
- Server validates the token on each connection and checks the `Origin` header matches the Tauri app origin as defence-in-depth
- `ws://` (not `wss://`) is acceptable — traffic never leaves localhost
- Note: any local process with access to the frontend's memory could intercept the token. This is acceptable for a desktop CAN bus tool — if an attacker has local process access, they have bigger problems.

### Multi-Window Support

WireTAP primarily uses a single "dashboard" window with Dockview panels. Optional pop-out windows (discovery, decoder, etc.) are separate WebView windows.

Each window opens its own WebSocket connection and subscribes to the channels it needs. The server accepts multiple authenticated connections and fans out messages to all connections subscribed to each channel. This matches the current `app.emit()` behaviour which broadcasts to all webview windows.

### Session Multiplexing

Each streaming session is assigned a **channel** (u8, 1-254):

- Frontend sends `Subscribe` message with session ID string
- Rust assigns the next available channel number, sends `SubscribeAck` containing both the assigned channel number and the session ID (for frontend confirmation)
- All subsequent messages for that session use the channel number (1 byte) instead of the full session ID string
- Frontend sends `Unsubscribe` when leaving a session
- Channel 0 is reserved for global messages (auth, heartbeat, lifecycle)
- If all 254 channels are in use, `Subscribe` is rejected with a `SessionError` on channel 0

The frontend maintains a local channel-to-sessionId map, updated on `SubscribeAck` and `Unsubscribe`.

### Reconnection

If the WebSocket connection drops (browser reload during dev, transient issue, WebView recreation):

1. Frontend detects `onclose` event and attempts automatic reconnect with exponential backoff
2. The auth token remains valid (not single-use — it's a shared secret for the app lifetime)
3. On reconnect, frontend re-authenticates and re-subscribes to all active session channels
4. Frames emitted during the disconnect window are not lost — they are in `buffer_store`. On reconnect, the frontend can fetch missed frames via `invoke` (offset-based pagination from its last known position)
5. Non-frame state messages (SessionState, StreamEnded, etc.) may be missed during disconnect. The frontend fetches current state via `invoke` after re-subscribing

## Message Format

Inspired by the FrameLink binary protocol (COBS-encoded, CRC-16 integrity, 5-byte header). Since WebSocket already provides message framing and TCP provides integrity, the COBS encoding and CRC are not needed. The header is simplified to 4 bytes.

### Header (4 bytes)

```
Offset  Size  Field
0       1     version_flags — [7:4] protocol version, [3:0] flags
1       1     msg_type      — message type enum
2       1     channel       — session channel (0 = global)
3       1     reserved      — future use
```

No length field — WebSocket messages are already length-delimited. Payload follows the header immediately. Total message = 4 bytes + payload.

**Protocol version:** 1. The version nibble allows future breaking changes. If a peer receives a version it doesn't support, it logs a warning and drops the message (does not disconnect).

**Flags nibble:** Reserved for future use (compression, priority, etc.).

### Message Types

| msg_type | Name | Direction | Channel | Payload |
|----------|------|-----------|---------|---------|
| 0x01 | FrameData | R→JS | Session | Batch of binary-encoded frames |
| 0x02 | SessionState | R→JS | Session | State enum (u8) + optional UTF-8 error message |
| 0x03 | StreamEnded | R→JS | Session | Reason (u8) + buffer metadata |
| 0x04 | SessionError | R→JS | Session | UTF-8 error string |
| 0x05 | PlaybackPosition | R→JS | Session | timestamp_us (u64 LE) + frame_index (u32 LE) + frame_count (u32 LE) |
| 0x06 | DeviceConnected | R→JS | Session | Device type + address (length-prefixed UTF-8) |
| 0x07 | BufferChanged | R→JS | Session | Buffer ID (length-prefixed UTF-8) |
| 0x08 | SessionLifecycle | R→JS | Global | Event type (u8) + session ID (length-prefixed UTF-8) + metadata |
| 0x09 | SessionInfo | R→JS | Session | Speed (f64 LE) + listener count (u16 LE) |
| 0x0A | Reconfigured | R→JS | Session | Empty |
| 0x0B | TransmitUpdated | R→JS | Global | Empty |
| 0x0C | ReplayState | R→JS | Global | Status (u8) + replay_id (length-prefixed UTF-8) + counters |
| 0x10 | Subscribe | JS→R | Global | Session ID (UTF-8, rest of payload) |
| 0x11 | Unsubscribe | JS→R | Session | Empty |
| 0x12 | SubscribeAck | R→JS | Session | Channel (u8) + session ID (length-prefixed UTF-8) |
| 0x13 | SubscribeNack | R→JS | Global | UTF-8 error string |
| 0xFE | Heartbeat | Both | Global | Empty |
| 0xFF | Auth | JS→R | Global | Token (UTF-8, rest of payload) |

### Events Remaining on Tauri

These infrequent events stay on Tauri `app.emit()` — they fire rarely (user actions, one-shot probes) and are not on any hot path:

| Event | Reason |
|-------|--------|
| `device-probe` | One-shot device probe result |
| `listener-evicted` | Rare administrative event |
| `store:changed` | Settings store writes (user-initiated) |
| `menu-*` events | Menu bar interactions |
| `device-discovered` / `device-scan-finished` | Device scan (short-lived) |
| `ble-*` / `smp-*` events | BLE provisioning / firmware upload (separate workflows) |
| `csv-import-progress` | Batch CSV import (short-lived) |
| `repeat-stopped` (transmit.rs) | Single event when transmit repeat ends |

Everything else moves to WebSocket.

## Frame Data Encoding (msg_type 0x01)

Inspired by FrameLink's frame definition concept. The WebSocket transport treats frame contents as opaque — it provides an envelope with metadata, and frame definitions describe how to interpret the contents based on type.

### Envelope (per frame within a FrameData batch)

```
Offset  Size      Field
0       8         timestamp_us (u64 LE) — microsecond timestamp
8       1         bus                   — bus number (0-7)
9       2         type (u16 LE)         — frame type identifier
11      1         len                   — data byte count (actual bytes, not CAN DLC code)
12      len       data                  — raw frame content (opaque to transport)
```

Fixed overhead: 12 bytes per frame. `len` is the actual data byte count (0-255), not the CAN DLC encoding. For CAN-FD, a 64-byte payload has `len=64`.

Frames are packed contiguously — no padding between them. The batch ends when the WebSocket message payload is consumed (message length - 4 byte header = total frame bytes to parse). If a frame's `len` field is inconsistent with remaining bytes, the entire batch is discarded and a `SessionError` is logged.

### Frame Type Identifiers

| type | Name | data layout |
|------|------|-------------|
| 0x0001 | CAN 2.0 | See CAN frame definition below |
| 0x0002 | CAN-FD | See CAN-FD frame definition below |
| 0x0003 | Modbus | Modbus PDU (implementation-defined) |
| 0x0004 | Serial | Raw serial bytes (no internal structure) |

New frame types are added by registering a new type identifier and its frame definition. The transport layer requires no changes.

### CAN 2.0 Frame Definition (type 0x0001)

```
Offset  Size  Field
0       4     id_flags (u32 LE)
                [28:0]  CAN ID (11-bit standard or 29-bit extended)
                [29]    is_extended (1 = 29-bit ID, 0 = 11-bit)
                [30]    is_rtr (remote transmission request)
                [31]    direction (1 = TX, 0 = RX)
4       N     payload (0-8 bytes, N = envelope.len - 4)
```

### CAN-FD Frame Definition (type 0x0002)

```
Offset  Size  Field
0       4     id_flags (u32 LE)
                [28:0]  CAN ID (11-bit standard or 29-bit extended)
                [29]    is_extended
                [30]    brs (bit rate switch)
                [31]    direction (1 = TX, 0 = RX)
4       N     payload (0-64 bytes, N = envelope.len - 4)
```

### Serial Frame Definition (type 0x0004)

No internal structure. `data` is raw bytes. `len` is the byte count. Used for both raw byte streams and framed serial data (SLIP, Modbus RTU delimiter-framed, etc.). The framing interpretation is handled by the application layer, not the transport.

### Source Address

For protocols that carry a source address (J1939, TWC), the source address is extracted from the CAN ID by the application layer using the frame definition's ID field. It is not a separate field in the transport envelope.

## Batching

Rust side batches frame data using the existing `SignalThrottle` cadence (500ms / 2Hz). Each `FrameData` message contains all frames accumulated since the last send. At typical CAN bus rates (~1000 frames/sec), each message carries ~500 frames x ~20 bytes = ~10 KB — fits in a single WebSocket binary frame.

For low-traffic scenarios (e.g., 2 frames/sec), messages are small (~50 bytes) and infrequent.

Non-frame messages (SessionState, PlaybackPosition, etc.) are sent immediately — they are infrequent and time-sensitive.

## Integration with Existing Architecture

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| Rust emit helpers | `emit_to_session(app, signal, sid, ())` | `ws_send(channel, msg_type, payload)` |
| sessionStore listeners | `listen("signal:${sid}", ...) + invoke(...)` | `ws.onmessage` dispatcher routes to callbacks |
| useIOSession listeners | Same Tauri listen pattern | Same WS dispatcher |
| SignalThrottle | Controls script evaluation rate | Controls WebSocket batch rate |
| Post-session cache | TTL cache for late-arriving fetches | Not needed — messages include full payload |
| Global events (transmit, replay) | `app.emit()` + frontend listener + invoke fetch | WebSocket messages (TransmitUpdated, ReplayState) |

### What Stays the Same

- Tauri `invoke` for all JS→Rust commands (session create/join/leave/start/stop, transmit, seek, settings, etc.)
- `buffer_store` for frame persistence (WebSocket is the delivery path, buffer_store is the persistence path)
- Session lifecycle management in `io/mod.rs`
- Frontend callback routing (sessionStore callbacks, useIOSession state updates)
- All frontend UI components
- Infrequent Tauri events listed in "Events Remaining on Tauri" section

### Startup Sequence

1. Tauri app starts, spawns WebSocket server on random port
2. Server generates auth token
3. Frontend calls `invoke("get_ws_config")` — receives `{ port, token }`
4. Frontend creates `WebSocket('ws://127.0.0.1:PORT')` with `binaryType = 'arraybuffer'`
5. Frontend sends `Auth` message with token
6. Server validates token and Origin header, connection established
7. When user starts a session, frontend sends `Subscribe` with session ID
8. Server assigns channel, sends `SubscribeAck` with channel + session ID
9. Session data flows as binary messages on the assigned channel

### Shutdown

- Frontend closes WebSocket on window unload
- Server detects disconnect, cleans up all channel subscriptions for that connection
- Server shuts down when app exits

### Error Race Condition

If a session errors before the frontend subscribes to its channel: the error is stored in the existing startup-error mechanism (`store_startup_error` in io/mod.rs). When the frontend subscribes, the `SubscribeAck` handler fetches startup errors via `invoke` — same pattern as today.

## Frontend Message Handling

The frontend registers a single `onmessage` handler that dispatches based on message type and channel:

```
ws.onmessage = (event) => {
  const buf = event.data;  // ArrayBuffer
  const view = new DataView(buf);
  const msgType = view.getUint8(1);
  const channel = view.getUint8(2);

  dispatch(msgType, channel, buf);
};
```

Frame data parsing uses `DataView` for zero-copy binary access — no JSON parsing, no string allocation, no intermediate objects.

## Platform Notes

- **macOS (WKWebView):** `ws://` to localhost works without ATS restrictions
- **Windows (WebView2):** Standard WebSocket support, no restrictions
- **Linux (WebKitGTK):** Standard WebSocket support
- **iOS (WKWebView):** `ws://` to localhost is exempt from ATS. Same architecture applies

## Success Criteria

1. WebView memory (WebKit malloc) stays flat during sustained streaming (verified via `footprint`)
2. All frame data, session state, and lifecycle events delivered via WebSocket
3. No script evaluation calls on any hot path
4. No ipc:// invoke calls on any hot path (invoke only for user-initiated commands)
5. Cross-platform: same WebSocket approach works on macOS, Windows, Linux
6. Frame data latency <= 500ms (2Hz batch cadence, same as current)
7. Binary encoding/decoding adds negligible CPU overhead compared to JSON

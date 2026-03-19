# Signal-Then-Fetch IPC Architecture

**Date:** 2026-03-15
**Status:** Draft
**Scope:** All Rust → frontend event delivery in WireTAP

## Problem

Tauri's `app.emit()` embeds serialised JSON payloads as JavaScript object literals inside `evaluate_script` calls. Each call produces a unique string that JavaScriptCore compiles as a new `UnlinkedProgramCodeBlock`. These compiled artefacts accumulate in WebKit's native malloc heap at ~18 MB/min under sustained streaming, never freed. The only leak-free IPC path is `invoke` responses via the `ipc://` custom protocol.

## Solution

Replace all payload-bearing `emit` calls with empty-payload signals. The frontend responds to each signal by fetching the current state via `invoke` through the proper IPC protocol. Data never flows through `evaluate_script` — only tiny, fixed-size signal strings do.

## Design

### Principle

Every Rust → frontend push becomes:
1. **Rust:** Store data in backend state (buffer store, session state, etc. — already done in most cases)
2. **Rust:** `emit_to_session(app, "signal-name", session_id, ())` — empty payload
3. **Frontend:** `listen("signal-name:<session_id>")` → calls `invoke("fetch_command")` via `ipc://`
4. **Frontend:** Processes the fetched data

No payload ever passes through `emit`. All data flows through `invoke` responses.

### Signal Throttling

Continuous signals (frames, playback, serial bytes) are throttled on the Rust side to ~2Hz (500ms interval). The backend accumulates data at full hardware rate but only signals the frontend at a human-perceptible rate.

```rust
const SIGNAL_INTERVAL_MS: u64 = 500;
```

One-shot signals (stream-ended, session-error, device-connected, buffer-changed) fire immediately — no throttling. A final flush signal fires when streaming stops to ensure the frontend receives the last state.

### Signal Vocabulary

#### Session-scoped signals (format: `signal-name:<session_id>`)

| Signal | Replaces | Throttled | Frontend fetches via |
|--------|----------|-----------|---------------------|
| `frames-ready` | `frame-message` | Yes (2Hz) | `getBufferFramesTail` (existing) |
| `bytes-ready` | `serial-raw-bytes` | Yes (2Hz) | `getBufferBytesTail` (new) |
| `playback-position` | `playback-time` | Yes (2Hz) | `getPlaybackPosition` (new) |
| `session-changed` | `session-state` | No (infrequent) | `getIOSessionState` (existing) |
| `session-info` | `speed-changed`, `joiner-count-changed` | Yes (2Hz) | `getIOSessionState` (existing) |
| `stream-ended` | `stream-ended`, `stream-complete` | No | `getStreamEndedInfo` (new) |
| `session-lifecycle` | `session-suspended`, `session-resuming`, `session-switched-to-buffer`, `device-replaced` | No | `getIOSessionState` (existing) |
| `session-reconfigured` | `session-reconfigured` | No | `getIOSessionState` (existing) |
| `session-error` | `session-error` | No | `getSessionError` (new) |
| `device-connected` | `device-connected` | No | `getSessionSources` (new) |
| `buffer-changed` | `buffer-orphaned`, `buffer-created` | No | `getBufferMetadata` (existing) |
| `modbus-scan` | `modbus-scan-frame`, `modbus-scan-progress`, `modbus-scan-device-info` | Yes (2Hz) | `getModbusScanState` (new) |

#### Global signals (no session scope)

| Signal | Replaces | Throttled | Frontend fetches via |
|--------|----------|-----------|---------------------|
| `transmit-updated` | `transmit-history-updated` | Yes (2Hz) | `transmitHistoryQuery` (existing) |
| `replay-progress` | `replay-progress` | Yes (2Hz) | `getReplayState` (new) |
| `replay-lifecycle` | `replay-started`, `replay-loop-restarted`, `repeat-stopped` | No | `getReplayState` (new) |
| `store:changed` | `store:changed` | No | Keep as-is (rare, tiny payload) |
| `session-lifecycle` | `session-lifecycle` (global) | No | Keep as-is (rare, tiny payload) |
| `device-probe` | `device-probe` | No | Keep as-is (rare, logging only) |
| `listener-evicted` | `listener-evicted` | No | No fetch — signal is sufficient |
| `menu-new-window` | `menu-new-window` | No | Keep as-is (user action) |
| `smp-upload-progress` | `smp-upload-progress`, `smp-upload-complete` | No | Keep as-is (short-lived, rare) |

Note: `modbus-scan-*` and `listener-evicted` are currently emitted globally (`app.emit`). They will be changed to session-scoped (`emit_to_session`) during migration for consistency.

### New Rust Commands

| Command | Returns | Purpose |
|---------|---------|---------|
| `get_playback_position` | `PlaybackPosition { timestamp_us, frame_index }` | Replace `playback-time` payload |
| `get_stream_ended_info` | `StreamEndedInfo { reason, buffer_id, buffer_type, buffer_available, count, time_range }` | Replace `stream-ended` payload |
| `get_session_error` | `Option<String>` | Replace `session-error` payload |
| `get_session_sources` | `Vec<SourceInfo { device_type, address, bus }>` | Replace `device-connected` payload |
| `get_replay_state` | `ReplayState { status, replay_id, frames_sent, total_frames, speed, loop_replay, pass }` | Replace `replay-*` payloads |
| `get_modbus_scan_state` | `ModbusScanState { status, frames, progress, device_info }` | Replace `modbus-scan-*` payloads |
| `get_buffer_bytes_tail` | `BytesTailResponse { bytes, total_count }` | Replace `serial-raw-bytes` payload |

All other fetch paths already exist (`getBufferFramesTail`, `getIOSessionState`, `getIOSessionCapabilities`, `getBufferMetadata`, `transmitHistoryQuery`, etc.).

### Race Condition Handling

One-shot signals (stream-ended, session-error, session-reconfigured) risk a race where the session is destroyed before the frontend's `invoke` fetch arrives. To handle this:

- **Store-then-signal:** Data is stored in backend state BEFORE the signal fires. This already happens for errors (`store_startup_error`). Apply the same pattern to stream-ended info, reconfigure state, and device sources.
- **Survive session destruction:** Stream-ended info and errors must persist briefly after session destruction so late-arriving fetches can still retrieve them. Use a small TTL cache keyed by session ID.
- **Reconfigure ordering:** `session-reconfigured` gets its own signal (not batched with other lifecycle events) so the frontend knows to clear stale state before the new stream starts.

### Active Listeners

The current `emit_frames` includes an `active_listeners` field for frontend callback filtering. In the signal-then-fetch model, this is no longer needed — the frontend decides which callbacks to invoke based on its own listener registrations. The `active_listeners` mechanism is eliminated.

### Rust-side Changes

**`emit_to_session`:** Strip payload parameter. All callers change from `emit_to_session(app, "event", session_id, payload)` to `emit_to_session(app, "signal", session_id, ())`.

**Signal throttle:** A `SignalThrottle` struct per session tracks the last emission time per signal name. The `should_signal` method returns true if enough time has elapsed. A `flush` method forces emission (called on stream stop).

**State storage:** Most data is already stored in backend state (buffer store, session state, replay state). Where it isn't (e.g., playback position, connected sources, scan state), add minimal state storage so `invoke` can query it.

### Frontend Changes

**`sessionStore.ts`:** `setupSessionEventListeners` simplifies. Each listener becomes:

```typescript
listen(`frames-ready:${sessionId}`, async () => {
  const response = await getBufferFramesTail(bufferId, tailSize, selectedIds);
  invokeCallbacks(eventListeners, "onFrames", response.frames);
});
```

**Eliminated:** `accumulateFrames`, `flushPendingFrames`, `pendingFramesMap`, `scheduleFlush`, `BATCH_SIZE_THRESHOLD`, `MIN_FLUSH_INTERVAL_MS`, `MAX_FLUSH_INTERVAL_MS`. The Rust throttle replaces all JS-side batching.

**`useTransmitHistorySubscription.ts`:** `transmit-history-updated` listener already has no payload. Just change to `transmit-updated` signal name and throttle on the Rust side.

**`useIOSession.ts`:** `listener-evicted` signal — no payload change needed.

**`Discovery.tsx`:** `modbus-scan-*` listeners merge into one `modbus-scan` listener that fetches `getModbusScanState`.

### Migration Scope

**Files to modify (Rust):**
- `src-tauri/src/io/mod.rs` — emit functions, signal throttle, new commands
- `src-tauri/src/io/multi_source/merge.rs` — frame emission
- `src-tauri/src/io/gs_usb/nusb_driver.rs` — frame emission, errors
- `src-tauri/src/io/timeline/buffer.rs` — playback, frames
- `src-tauri/src/io/timeline/csv.rs` — playback, frames
- `src-tauri/src/io/timeline/postgres.rs` — playback, frames, stream ended
- `src-tauri/src/io/mqtt/reader.rs` — frames, errors
- `src-tauri/src/io/modbus_tcp/reader.rs` — frames, scan events
- `src-tauri/src/io/virtual_device/mod.rs` — frames, bytes
- `src-tauri/src/transmit.rs` — history updated, repeat stopped
- `src-tauri/src/replay.rs` — replay events
- `src-tauri/src/sessions.rs` — register new commands
- `src-tauri/src/lib.rs` — register new commands

**Files to modify (Frontend):**
- `src/stores/sessionStore.ts` — event listeners, eliminate batching
- `src/hooks/useIOSession.ts` — listener-evicted
- `src/apps/transmit/hooks/useTransmitHistorySubscription.ts` — transmit events
- `src/apps/discovery/Discovery.tsx` — modbus scan events
- `src/hooks/useSessionLogSubscription.ts` — lifecycle, probe events
- `src/apps/session-manager/hooks/useSessionLogSubscription.ts` — session log event listeners
- `src/api/io.ts` — new invoke wrappers

## What This Does NOT Change

- **Buffer store:** No changes — it already stores all frame data
- **Session state machine:** No changes — states already queryable
- **Frontend component rendering:** Components receive data through the same callback interfaces
- **Transmit history SQLite:** No changes — already queryable via `transmitHistoryQuery`

## Success Criteria

- WebView process memory stable under sustained streaming (footprint measured via `footprint` tool)
- `UnlinkedProgramCodeBlock` count stable in heap snapshots
- All existing functionality preserved — frame display, playback, serial, modbus scanning, transmit history, replay
- No polling — all updates are signal-driven

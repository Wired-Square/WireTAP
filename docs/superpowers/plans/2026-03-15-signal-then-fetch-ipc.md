# Signal-Then-Fetch IPC Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate WebView memory leaks (~18 MB/min) by replacing all payload-bearing Tauri `emit()` calls with empty-payload signals. The frontend responds to each signal by fetching current state via `invoke` through the leak-free `ipc://` protocol.

**Architecture:** Every Rust-to-frontend push becomes: (1) store data in backend state (already done in most cases), (2) emit empty-payload signal, (3) frontend listens for signal and fetches via invoke. Continuous signals (frames, bytes, playback) are throttled to 2Hz (500ms) on the Rust side. One-shot signals fire immediately. A post-session TTL cache handles the race condition where sessions are destroyed before the frontend's fetch arrives.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Zustand 5

---

## Spec

`docs/superpowers/specs/2026-03-15-signal-then-fetch-ipc-design.md`

## File Map

### New Rust Files

| File | Responsibility |
|------|---------------|
| `src-tauri/src/io/signal_throttle.rs` | `SignalThrottle` struct — per-session 2Hz rate limiting for continuous signals |
| `src-tauri/src/io/post_session.rs` | TTL cache for state that must survive session destruction (stream-ended info, errors, sources) |

### Modified Rust Files

| File | Changes |
|------|---------|
| `src-tauri/src/io/mod.rs` | New modules, new state globals (playback positions, session sources), update emit helpers, remove `FrameBatchPayload` |
| `src-tauri/src/io/multi_source/merge.rs` | SignalThrottle, emit `frames-ready`/`bytes-ready` signals instead of payloads |
| `src-tauri/src/io/gs_usb/nusb_driver.rs` | SignalThrottle, emit `frames-ready` signal |
| `src-tauri/src/io/timeline/buffer.rs` | SignalThrottle, emit `frames-ready`/`playback-position` signals, store playback position |
| `src-tauri/src/io/timeline/csv.rs` | SignalThrottle, emit `frames-ready`/`playback-position` signals, store playback position |
| `src-tauri/src/io/timeline/postgres.rs` | SignalThrottle, emit `frames-ready`/`playback-position` signals, store playback position |
| `src-tauri/src/io/mqtt/reader.rs` | SignalThrottle, emit `frames-ready` signal |
| `src-tauri/src/io/modbus_tcp/reader.rs` | SignalThrottle, emit `frames-ready` signal |
| `src-tauri/src/io/modbus_tcp/scanner.rs` | Add session_id parameter, session-scoped `modbus-scan` signal, state storage |
| `src-tauri/src/io/virtual_device/mod.rs` | SignalThrottle, emit `frames-ready`/`bytes-ready` signals |
| `src-tauri/src/transmit.rs` | SignalThrottle for `transmit-updated` (`repeat-stopped` kept as-is — not part of leak) |
| `src-tauri/src/replay.rs` | Replay state storage, emit `replay-progress`/`replay-lifecycle` signals |
| `src-tauri/src/sessions.rs` | New invoke commands, register in handler |
| `src-tauri/src/buffers.rs` | New `get_buffer_bytes_tail` command |
| `src-tauri/src/lib.rs` | Register new invoke commands |

### Modified Frontend Files

| File | Changes |
|------|---------|
| `src/api/io.ts` | New invoke wrappers for all fetch commands |
| `src/stores/sessionStore.ts` | Signal-based listeners, remove batching (`accumulateFrames`, `flushPendingFrames`, `pendingFramesMap`, `scheduleFlush`, thresholds), remove `active_listeners` routing |
| `src/hooks/useIOSession.ts` | Signal-based state listeners (session-changed, playback-position, stream-ended, session-lifecycle, etc.) |
| `src/apps/transmit/hooks/useTransmitHistorySubscription.ts` | `transmit-updated` signal name |
| `src/apps/discovery/Discovery.tsx` | Merge modbus scan listeners into one `modbus-scan` listener |
| `src/hooks/useSessionLogSubscription.ts` | Signal name changes for logging |
| `src/apps/session-manager/hooks/useSessionLogSubscription.ts` | Signal name changes for logging |

## Signal Vocabulary Quick Reference

### Session-scoped (format: `signal-name:<session_id>`)

| New Signal | Replaces | Throttled | Frontend fetches via |
|------------|----------|-----------|---------------------|
| `frames-ready` | `frame-message` | Yes | `get_buffer_frames_tail` (existing) |
| `bytes-ready` | `serial-raw-bytes` | Yes | `get_buffer_bytes_tail` (new) |
| `playback-position` | `playback-time` | Yes | `get_playback_position` (new) |
| `session-changed` | `session-state` | No | `get_reader_session_state` (existing) |
| `session-info` | `speed-changed`, `joiner-count-changed` | No (see note) | `get_reader_session_state` (existing) |
| `stream-ended` | `stream-ended`, `stream-complete` | No | `get_stream_ended_info` (new) |
| `session-lifecycle` (session-scoped) | `session-suspended`, `session-resuming`, `session-switched-to-buffer`, `session-device-replaced` | No | `get_reader_session_state` (existing) |
| `session-reconfigured` | `session-reconfigured` | No | `get_reader_session_state` (existing) |
| `session-error` | `session-error` | No | `get_session_error` (new) |
| `device-connected` | `device-connected` | No | `get_session_sources` (new) |
| `buffer-changed` | `buffer-orphaned`, `buffer-created` | No | `get_buffer_metadata` (existing) |
| `modbus-scan` | `modbus-scan-frame`, `modbus-scan-progress`, `modbus-scan-device-info` | Yes | `get_modbus_scan_state` (new) |

### Global (no session scope)

| New Signal | Replaces | Throttled | Frontend fetches via |
|------------|----------|-----------|---------------------|
| `transmit-updated` | `transmit-history-updated` | Yes | `transmitHistoryQuery` (existing) |
| `replay-progress` | `replay-progress` | Yes | `get_replay_state` (new) |
| `replay-lifecycle` | `replay-started`, `replay-loop-restarted`, `repeat-stopped` (replay.rs only) | No | `get_replay_state` (new) |
| `store:changed` | — | — | Keep as-is (rare, tiny payload) |
| `session-lifecycle` | — | — | Keep as-is (rare, tiny payload) |
| `device-probe` | — | — | Keep as-is (rare, logging only) |
| `listener-evicted` | — | — | Keep as-is (no fetch — signal is sufficient) |
| `menu-new-window` | — | — | Keep as-is (user action) |
| `smp-upload-progress` | — | — | Keep as-is (short-lived, rare) |

### Important Notes

**`session-lifecycle` name overlap:** The session-scoped `session-lifecycle` signal (replacing `session-suspended`, etc.) and the global `session-lifecycle` signal (keep-as-is for create/destroy) share the same base name. They do NOT collide at runtime because session-scoped signals are emitted as `session-lifecycle:<session_id>` via `emit_to_session`, while global signals use bare `session-lifecycle` via `app.emit`. Frontend listeners must always include the `:<session_id>` suffix for the session-scoped version.

**`session-info` throttling:** The spec says 2Hz, but `speed-changed` and `joiner-count-changed` are emitted from session management helpers in `io/mod.rs` (not from IO tasks), where no `SignalThrottle` instance exists. In practice these signals are already infrequent (user-initiated speed changes, listener join/leave). Emit unconditionally — their real-world frequency is well below 2Hz.

**`repeat-stopped` scope:** The spec maps `repeat-stopped` to `replay-lifecycle`. However, `repeat-stopped` is emitted from BOTH `replay.rs` (replay operations) and `transmit.rs` (single-frame repeat transmissions). Only `replay.rs`'s `repeat-stopped` becomes `replay-lifecycle`. `transmit.rs`'s `repeat-stopped` stays as-is — it's from transmit repeats (not replay), is infrequent, and has a tiny payload.

## Migration Pattern

Every signal migration follows this pattern. Task 4 provides the reference implementation with full code; subsequent tasks follow the same structure.

**Rust side:**
1. Data is already stored in backend state before emission (buffer_store, session state, etc.)
2. For new state (playback position, replay state, etc.), add state storage BEFORE emitting
3. Replace `emit_to_session(app, "old-event", session_id, payload)` with `emit_to_session(app, "new-signal", session_id, ())`
4. For continuous signals: check `throttle.should_signal("signal-name")` before emitting
5. On stream stop: call `throttle.flush()` and emit final signal to ensure frontend gets last state

**Frontend side:**
1. Replace payload-based listener:
   ```typescript
   // Before
   listen(`old-event:${sessionId}`, (event) => { use(event.payload); });
   // After
   listen(`new-signal:${sessionId}`, async () => {
     const data = await fetchCommand(args);
     processData(data);
   });
   ```
2. Remove unused payload type definitions

---

## Chunk 1: Rust Infrastructure

### Task 1: SignalThrottle Module

**Files:**
- Create: `src-tauri/src/io/signal_throttle.rs`
- Modify: `src-tauri/src/io/mod.rs` (add module declaration)

- [ ] **Step 1: Create signal_throttle.rs with struct and unit tests**

```rust
// src-tauri/src/io/signal_throttle.rs
use std::collections::HashMap;
use std::time::Instant;

/// Interval between throttled signals (500ms = 2Hz)
const SIGNAL_INTERVAL_MS: u64 = 500;

/// Per-session signal rate limiter.
///
/// Owned by each IO task (not shared globally). Tracks last emission time
/// per signal name. Continuous signals check `should_signal()` before emitting.
/// One-shot signals bypass the throttle entirely.
pub struct SignalThrottle {
    last_signal: HashMap<String, Instant>,
}

impl SignalThrottle {
    pub fn new() -> Self {
        Self {
            last_signal: HashMap::new(),
        }
    }

    /// Returns `true` if enough time has elapsed since the last signal.
    /// Updates the timestamp when returning true.
    pub fn should_signal(&mut self, signal_name: &str) -> bool {
        let now = Instant::now();
        match self.last_signal.get(signal_name) {
            Some(last)
                if now.duration_since(*last).as_millis() < SIGNAL_INTERVAL_MS as u128 =>
            {
                false
            }
            _ => {
                self.last_signal.insert(signal_name.to_string(), now);
                true
            }
        }
    }

    /// Clear all timestamps so the next signal of any name fires immediately.
    /// Call on stream stop to ensure a final flush signal reaches the frontend.
    pub fn flush(&mut self) {
        self.last_signal.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn first_signal_always_passes() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
    }

    #[test]
    fn immediate_repeat_is_blocked() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        assert!(!t.should_signal("test"));
    }

    #[test]
    fn different_names_are_independent() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("a"));
        assert!(t.should_signal("b"));
        assert!(!t.should_signal("a"));
    }

    #[test]
    fn flush_resets_all() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        assert!(!t.should_signal("test"));
        t.flush();
        assert!(t.should_signal("test"));
    }

    #[test]
    fn passes_after_interval() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(t.should_signal("test"));
    }
}
```

- [ ] **Step 2: Add module declaration to io/mod.rs**

Near the top of `src-tauri/src/io/mod.rs`, with the other `mod` declarations:
```rust
mod signal_throttle;
pub use signal_throttle::SignalThrottle;
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test signal_throttle -- --nocapture`
Expected: All 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/io/signal_throttle.rs src-tauri/src/io/mod.rs
git commit -m "feat(ipc): add SignalThrottle for 2Hz signal rate limiting"
```

---

### Task 2: Post-Session State Cache

State that must survive session destruction so late-arriving frontend fetches succeed. Extends the existing `STARTUP_ERRORS` pattern.

**Files:**
- Create: `src-tauri/src/io/post_session.rs`
- Modify: `src-tauri/src/io/mod.rs` (add module)

- [ ] **Step 1: Create post_session.rs**

```rust
// src-tauri/src/io/post_session.rs
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

/// How long post-session data survives after storage
const TTL: Duration = Duration::from_secs(10);

/// Stream-ended info, persisted after session destruction for late-arriving fetches.
#[derive(Clone, Debug, Serialize)]
pub struct StreamEndedInfo {
    pub reason: String,
    pub buffer_available: bool,
    pub buffer_id: Option<String>,
    pub buffer_type: Option<String>,
    pub count: usize,
    pub time_range: Option<(u64, u64)>,
}

/// Connected source info for a session.
#[derive(Clone, Debug, Serialize)]
pub struct SourceInfo {
    pub device_type: String,
    pub address: String,
    pub bus: Option<u8>,
}

struct Entry {
    stream_ended: Option<StreamEndedInfo>,
    error: Option<String>,
    sources: Vec<SourceInfo>,
    stored_at: Instant,
}

static CACHE: Lazy<RwLock<HashMap<String, Entry>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn get_or_create_entry(
    cache: &mut HashMap<String, Entry>,
    session_id: &str,
) -> &mut Entry {
    cache
        .entry(session_id.to_string())
        .or_insert_with(|| Entry {
            stream_ended: None,
            error: None,
            sources: Vec::new(),
            stored_at: Instant::now(),
        })
}

pub fn store_stream_ended(session_id: &str, info: StreamEndedInfo) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.stream_ended = Some(info);
        entry.stored_at = Instant::now();
    }
}

pub fn store_error(session_id: &str, error: String) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.error = Some(error);
        entry.stored_at = Instant::now();
    }
}

pub fn store_source(session_id: &str, source: SourceInfo) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.sources.push(source);
        entry.stored_at = Instant::now();
    }
}

pub fn get_stream_ended(session_id: &str) -> Option<StreamEndedInfo> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .and_then(|e| e.stream_ended.clone())
        })
}

pub fn get_error(session_id: &str) -> Option<String> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .and_then(|e| e.error.clone())
        })
}

pub fn get_sources(session_id: &str) -> Vec<SourceInfo> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .map(|e| e.sources.clone())
        })
        .unwrap_or_default()
}

/// Remove expired entries. Call periodically (e.g., on session destroy).
pub fn sweep_expired() {
    if let Ok(mut cache) = CACHE.write() {
        cache.retain(|_, entry| entry.stored_at.elapsed() < TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_retrieve_stream_ended() {
        let sid = "ps_test_stream";
        store_stream_ended(
            sid,
            StreamEndedInfo {
                reason: "complete".into(),
                buffer_available: true,
                buffer_id: Some("buf1".into()),
                buffer_type: Some("frames".into()),
                count: 42,
                time_range: Some((1000, 2000)),
            },
        );
        let info = get_stream_ended(sid).unwrap();
        assert_eq!(info.reason, "complete");
        assert_eq!(info.count, 42);
    }

    #[test]
    fn store_and_retrieve_error() {
        let sid = "ps_test_err";
        store_error(sid, "broke".into());
        assert_eq!(get_error(sid), Some("broke".into()));
    }

    #[test]
    fn store_and_retrieve_sources() {
        let sid = "ps_test_src";
        store_source(
            sid,
            SourceInfo {
                device_type: "gs_usb".into(),
                address: "USB1".into(),
                bus: Some(0),
            },
        );
        let sources = get_sources(sid);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].device_type, "gs_usb");
    }

    #[test]
    fn missing_session_returns_none() {
        assert!(get_stream_ended("nonexistent_ps").is_none());
        assert!(get_error("nonexistent_ps").is_none());
        assert!(get_sources("nonexistent_ps").is_empty());
    }
}
```

- [ ] **Step 2: Add module declaration to io/mod.rs**

```rust
pub mod post_session;
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test post_session -- --nocapture`
Expected: All 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/io/post_session.rs src-tauri/src/io/mod.rs
git commit -m "feat(ipc): add post-session TTL cache for signal-then-fetch"
```

---

### Task 3: New Invoke Commands and State Storage

Add all new Rust state globals, Tauri commands, and frontend API wrappers needed by the signal-then-fetch migration.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (playback position storage)
- Modify: `src-tauri/src/replay.rs` (replay state storage + command)
- Modify: `src-tauri/src/io/modbus_tcp/scanner.rs` (scan state storage + session_id)
- Modify: `src-tauri/src/sessions.rs` (new Tauri commands)
- Modify: `src-tauri/src/buffers.rs` (get_buffer_bytes_tail command)
- Modify: `src-tauri/src/lib.rs` (register commands)
- Modify: `src/api/io.ts` (frontend wrappers)

#### Rust State Storage

- [ ] **Step 1: Add playback position storage to io/mod.rs**

Add a global map near `IO_SESSIONS` (~line 779):
```rust
/// Current playback position per session (for signal-then-fetch).
/// Written by timeline readers before emitting playback-position signal.
static PLAYBACK_POSITIONS: Lazy<RwLock<HashMap<String, PlaybackPosition>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Store the current playback position for a session.
pub fn store_playback_position(session_id: &str, position: PlaybackPosition) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.insert(session_id.to_string(), position);
    }
}

/// Retrieve the current playback position for a session.
pub fn get_playback_position(session_id: &str) -> Option<PlaybackPosition> {
    PLAYBACK_POSITIONS
        .read()
        .ok()
        .and_then(|p| p.get(session_id).cloned())
}

/// Clear playback position for a session (called on destroy).
pub fn clear_playback_position(session_id: &str) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.remove(session_id);
    }
}
```

The existing `PlaybackPosition` struct (~line 132) already has `Clone` and `Serialize`, which is sufficient for invoke responses. No changes needed to its derives.

- [ ] **Step 2: Add replay state storage to replay.rs**

Add near the `IO_REPLAY_TASKS` global. Note: `replay.rs` uses `tokio::sync::Mutex` for the existing task map, but the state map should use `std::sync::Mutex` (non-async, RwLock would also work) since reads are from synchronous Tauri commands:
```rust
use std::sync::Mutex as StdMutex;

/// Queryable replay state for signal-then-fetch.
#[derive(Clone, Debug, Serialize)]
pub struct ReplayState {
    pub status: String,
    pub replay_id: String,
    pub frames_sent: usize,
    pub total_frames: usize,
    pub speed: f64,
    pub loop_replay: bool,
    pub pass: usize,
}

static REPLAY_STATES: Lazy<StdMutex<HashMap<String, ReplayState>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

fn store_replay_state(replay_id: &str, state: ReplayState) {
    if let Ok(mut states) = REPLAY_STATES.lock() {
        states.insert(replay_id.to_string(), state);
    }
}

fn clear_replay_state(replay_id: &str) {
    if let Ok(mut states) = REPLAY_STATES.lock() {
        states.remove(replay_id);
    }
}

#[tauri::command]
pub fn get_replay_state(replay_id: String) -> Option<ReplayState> {
    REPLAY_STATES
        .lock()
        .ok()
        .and_then(|s| s.get(&replay_id).cloned())
}
```

Update the replay task to call `store_replay_state` at each progress point (where `replay-progress`, `replay-started`, `replay-loop-restarted`, and `repeat-stopped` are currently emitted). Clear on task completion.

- [ ] **Step 3: Add modbus scan state storage to scanner.rs**

Add near the top of `src-tauri/src/io/modbus_tcp/scanner.rs`:
```rust
use std::collections::HashMap;
use std::sync::RwLock;
use once_cell::sync::Lazy;

#[derive(Clone, Debug, Serialize)]
pub struct ModbusScanState {
    pub status: String,
    pub frames: Vec<FrameMessage>,
    pub progress: Option<ScanProgressPayload>,
    pub device_info: Vec<DeviceInfoPayload>,
}

static SCAN_STATES: Lazy<RwLock<HashMap<String, ModbusScanState>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn store_scan_state(session_id: &str, state: ModbusScanState) {
    if let Ok(mut states) = SCAN_STATES.write() {
        states.insert(session_id.to_string(), state);
    }
}

pub fn get_scan_state(session_id: &str) -> Option<ModbusScanState> {
    SCAN_STATES.read().ok().and_then(|s| s.get(session_id).cloned())
}

pub fn clear_scan_state(session_id: &str) {
    if let Ok(mut states) = SCAN_STATES.write() {
        states.remove(session_id);
    }
}
```

Add `session_id: Option<String>` parameter to `modbus_scan_registers` and `modbus_scan_unit_ids` signatures, and update the Tauri command wrappers in `sessions.rs` to pass it through.

#### Rust Tauri Commands

- [ ] **Step 4: Add new commands to sessions.rs**

```rust
#[tauri::command(rename_all = "snake_case")]
pub fn get_playback_position_cmd(session_id: String) -> Option<io::PlaybackPosition> {
    io::get_playback_position(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_stream_ended_info(session_id: String) -> Option<io::post_session::StreamEndedInfo> {
    io::post_session::get_stream_ended(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_session_error(session_id: String) -> Option<String> {
    // Check post-session cache first (non-consuming), then startup errors (non-consuming).
    // Note: the existing take_startup_error() consumes on read. Add a non-consuming
    // get_startup_error() to io/mod.rs that reads without removing:
    //   pub fn get_startup_error(session_id: &str) -> Option<String> {
    //       STARTUP_ERRORS.read().ok().and_then(|e| e.get(session_id).cloned())
    //   }
    io::post_session::get_error(&session_id)
        .or_else(|| io::get_startup_error(&session_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_session_sources(session_id: String) -> Vec<io::post_session::SourceInfo> {
    io::post_session::get_sources(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_modbus_scan_state_cmd(session_id: String) -> Option<crate::io::modbus_tcp::scanner::ModbusScanState> {
    crate::io::modbus_tcp::scanner::get_scan_state(&session_id)
}
```

- [ ] **Step 5: Add get_buffer_bytes_tail to buffers.rs**

There is no existing `buffer_store::get_buffer_bytes_tail` function. Implement using the existing `buffer_store::get_buffer_bytes_paginated(id, offset, limit) -> (Vec<TimestampedByte>, usize)` and `buffer_store::get_buffer_count(id) -> usize`:

```rust
#[derive(Serialize)]
pub struct BytesTailResponse {
    pub bytes: Vec<crate::buffer_store::TimestampedByte>,
    pub total_count: usize,
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_buffer_bytes_tail(
    buffer_id: String,
    tail_size: usize,
) -> BytesTailResponse {
    let total_count = buffer_store::get_buffer_count(&buffer_id);
    let offset = total_count.saturating_sub(tail_size);
    let limit = tail_size.min(total_count);
    let (bytes, _) = buffer_store::get_buffer_bytes_paginated(&buffer_id, offset, limit);
    BytesTailResponse { bytes, total_count }
}
```

- [ ] **Step 6: Register all new commands in lib.rs**

Add to the `.invoke_handler(tauri::generate_handler![...])` block (~line 948):
```rust
sessions::get_playback_position_cmd,
sessions::get_stream_ended_info,
sessions::get_session_error,
sessions::get_session_sources,
sessions::get_modbus_scan_state_cmd,
replay::get_replay_state,
buffers::get_buffer_bytes_tail,
```

- [ ] **Step 7: Integrate cleanup into destroy_session**

In `io/mod.rs`, in the `destroy_session` function, add cleanup calls alongside the existing `clear_startup_error`:
```rust
clear_playback_position(session_id);
post_session::sweep_expired(); // Clean up any expired entries from other sessions
```

Also add a non-consuming `get_startup_error` function near the existing `take_startup_error`:
```rust
/// Read (without removing) the startup error for a session.
pub fn get_startup_error(session_id: &str) -> Option<String> {
    STARTUP_ERRORS.read().ok().and_then(|e| e.get(session_id).cloned())
}
```

- [ ] **Step 8: Build to verify**

Run: `cd src-tauri && cargo build 2>&1 | head -50`
Expected: Successful build (warnings OK at this stage).

#### Frontend API Wrappers

- [ ] **Step 9: Add new fetch wrappers to src/api/io.ts**

Add after the existing `getIOSessionState` function:
```typescript
/** Fetch current playback position for a timeline/buffer session. */
export async function getPlaybackPosition(
  sessionId: string
): Promise<PlaybackPosition | null> {
  return invoke("get_playback_position_cmd", { session_id: sessionId });
}

/** Playback position as stored by timeline readers. */
export interface PlaybackPosition {
  timestamp_us: number;
  frame_index: number;
  frame_count?: number;
}

/** Fetch stream-ended info (survives session destruction via TTL cache). */
export async function getStreamEndedInfo(
  sessionId: string
): Promise<StreamEndedInfo | null> {
  return invoke("get_stream_ended_info", { session_id: sessionId });
}

/** Stream-ended info returned by the post-session cache. */
export interface StreamEndedInfo {
  reason: string;
  buffer_available: boolean;
  buffer_id: string | null;
  buffer_type: string | null;
  count: number;
  time_range: [number, number] | null;
}

/** Fetch the last session error (from post-session cache or startup errors). */
export async function getSessionError(
  sessionId: string
): Promise<string | null> {
  return invoke("get_session_error", { session_id: sessionId });
}

/** Fetch connected sources for a session. */
export async function getSessionSources(
  sessionId: string
): Promise<SourceInfo[]> {
  return invoke("get_session_sources", { session_id: sessionId });
}

export interface SourceInfo {
  device_type: string;
  address: string;
  bus: number | null;
}

/** Fetch current replay state. */
export async function getReplayState(
  replayId: string
): Promise<ReplayState | null> {
  return invoke("get_replay_state", { replay_id: replayId });
}

export interface ReplayState {
  status: string;
  replay_id: string;
  frames_sent: number;
  total_frames: number;
  speed: number;
  loop_replay: boolean;
  pass: number;
}

/** Fetch current modbus scan state. */
export async function getModbusScanState(
  sessionId: string
): Promise<ModbusScanState | null> {
  return invoke("get_modbus_scan_state_cmd", { session_id: sessionId });
}

export interface ModbusScanState {
  status: string;
  frames: FrameMessage[];
  progress: { current: number; total: number; found_count: number } | null;
  device_info: { unit_id: number; vendor: string; product_code: string; revision: string }[];
}

/** Fetch the most recent bytes from a buffer (tail view). */
export async function getBufferBytesTail(
  bufferId: string,
  tailSize: number
): Promise<BytesTailResponse> {
  return invoke("get_buffer_bytes_tail", { buffer_id: bufferId, tail_size: tailSize });
}

export interface BytesTailResponse {
  bytes: RawByteEntry[];
  total_count: number;
}
```

- [ ] **Step 10: Build frontend to verify types**

Run: `cd /path/to/WireTAP && npx tsc --noEmit 2>&1 | head -20`
Expected: No new type errors.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/io/mod.rs src-tauri/src/replay.rs src-tauri/src/io/modbus_tcp/scanner.rs \
  src-tauri/src/sessions.rs src-tauri/src/buffers.rs src-tauri/src/lib.rs src/api/io.ts
git commit -m "feat(ipc): add state storage, invoke commands, and API wrappers for signal-then-fetch"
```

---

## Chunk 2: High-Frequency Signal Migration

These signals cause the memory leak — they fire at hardware rate during streaming. Migrating them eliminates the primary leak source.

### Task 4: frames-ready Signal (Reference Implementation)

This is the highest-impact change. It replaces `frame-message` (the #1 source of WebKit malloc growth) with a `frames-ready` signal. The frontend fetches frames via the existing `get_buffer_frames_tail` command.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (~line 1247: `emit_frames`)
- Modify: `src-tauri/src/io/multi_source/merge.rs` (frame emission)
- Modify: `src-tauri/src/io/gs_usb/nusb_driver.rs` (frame emission)
- Modify: `src-tauri/src/io/mqtt/reader.rs` (frame emission)
- Modify: `src-tauri/src/io/modbus_tcp/reader.rs` (frame emission)
- Modify: `src-tauri/src/io/timeline/buffer.rs` (frame emission + direct `emit_to_session("frame-message", ...)`)
- Modify: `src-tauri/src/io/virtual_device/mod.rs` (frame emission)
- Modify: `src/stores/sessionStore.ts` (listener + remove batching)
- Modify: `src/hooks/useIOSession.ts` (if it listens to frame-message directly)

#### Rust Side

- [ ] **Step 1: Change `emit_frames` helper in io/mod.rs**

Replace the current `emit_frames` function (~line 1247-1258) with a signal-only version. The function no longer needs a `frames` parameter — data is already in the buffer store.

```rust
/// Signal the frontend that new frames are available for a session.
/// The frontend fetches frames via get_buffer_frames_tail.
/// For throttled use: check SignalThrottle::should_signal("frames-ready") before calling.
pub fn signal_frames_ready(app: &AppHandle, session_id: &str) {
    emit_to_session(app, "frames-ready", session_id, ());
}
```

Keep the old `emit_frames` temporarily but mark it `#[deprecated]` so callers can be migrated incrementally. Or remove it outright if migrating all callers in this task.

Also remove the `FrameBatchPayload` struct (~line 122-129) once all callers are migrated.

- [ ] **Step 2: Migrate multi_source/merge.rs**

In `merge.rs`, the merge task currently calls `emit_frames(app, session_id, frames)` at two points (batch emit ~line 236 and final drain ~line 258). The task already stores frames in `buffer_store::append_frames_to_session` before emitting.

Changes:
1. Add `use crate::io::SignalThrottle;` at the top
2. Create `let mut throttle = SignalThrottle::new();` at task start
3. Replace batch emit: `emit_frames(...)` → `if throttle.should_signal("frames-ready") { signal_frames_ready(&app, &session_id); }`
4. For the final drain: `throttle.flush(); signal_frames_ready(&app, &session_id);`

- [ ] **Step 3: Migrate gs_usb/nusb_driver.rs**

The gs_usb driver calls `emit_frames` at two points (~line 782 for periodic emit, ~line 809 for drain). Frames are already stored in buffer_store before emission.

Changes:
1. Add `SignalThrottle` import and create at task start
2. Replace `emit_frames(...)` at line 782 → `if throttle.should_signal("frames-ready") { signal_frames_ready(...); }`
3. Final drain at line 809: `throttle.flush(); signal_frames_ready(...);`

- [ ] **Step 4: Migrate mqtt/reader.rs**

MQTT reader calls `emit_frames` per message (~line 316). Frames are already stored in buffer_store.

Changes:
1. Add `SignalThrottle`, create at task start
2. Replace `emit_frames(...)` → throttled signal

- [ ] **Step 5: Migrate modbus_tcp/reader.rs**

Modbus reader calls `emit_frames` per register read (~line 347). Frames are stored in buffer_store.

Changes:
1. Add `SignalThrottle`, create at task start
2. Replace `emit_frames(...)` → throttled signal

- [ ] **Step 6: Migrate timeline/buffer.rs**

Buffer reader has multiple frame emission points:
- `emit_frames(...)` call (~line 369, seek snapshot)
- Direct `emit_to_session(app, "frame-message", ...)` calls (~line 344, and batch emit paths)

All of these change to `signal_frames_ready`. The throttle is used for the continuous playback path; seek snapshots fire immediately (one-shot).

Changes:
1. Add `SignalThrottle`, create at task start
2. Replace all `emit_to_session("frame-message", ...)` and `emit_frames(...)` calls with `signal_frames_ready`
3. Use throttle for the playback loop emissions
4. Skip throttle for seek snapshot (immediate signal)
5. Flush throttle and signal on pause/complete

- [ ] **Step 7: Migrate timeline/csv.rs and timeline/postgres.rs**

Same pattern as buffer.rs. Replace frame emission with throttled `signal_frames_ready`. Both already store frames in buffer_store before emission.

- [ ] **Step 8: Migrate virtual_device/mod.rs**

Virtual device calls `emit_frames` per tick (~line 529, 557, 581) and for loopback (~line 643). All stored in buffer_store.

Changes:
1. Add `SignalThrottle`, create at task start
2. Replace `emit_frames(...)` → throttled signal
3. Loopback frames: throttled signal (same throttle instance)

- [ ] **Step 9: Build Rust**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: Build succeeds.

#### Frontend Side

- [ ] **Step 10: Migrate sessionStore.ts frame listener**

In `setupSessionEventListeners`, find the `frame-message:${sessionId}` listener. Replace with:

```typescript
listen(`frames-ready:${sessionId}`, async () => {
  const eventListeners = getEventListeners()[sessionId];
  if (!eventListeners) return;

  // Get the buffer ID from session store state (not from eventListeners).
  // The buffer ID is tracked on the session state, e.g. get().sessions[sessionId]?.buffer?.id
  // or passed as a closure variable when setupSessionEventListeners is called.
  const bufferId = /* resolve from session store state */;
  if (!bufferId) return;

  const response = await getBufferFramesTail(bufferId, tailSize, selectedIds);
  if (response.frames.length > 0) {
    invokeCallbacks(eventListeners, "onFrames", response.frames);
  }
});
```

Where `getBufferFramesTail` is the existing invoke wrapper (in `src/api/buffer.ts`) and `invokeCallbacks` iterates the registered callback map. The buffer ID must be resolved from the sessionStore's session state — check how `setupSessionEventListeners` currently receives and stores the buffer ID.

- [ ] **Step 11: Remove frame batching from sessionStore.ts**

Delete:
- `accumulateFrames` function
- `flushPendingFrames` function
- `pendingFramesMap` variable
- `scheduleFlush` / flush timer logic
- `BATCH_SIZE_THRESHOLD`, `MIN_FLUSH_INTERVAL_MS`, `MAX_FLUSH_INTERVAL_MS` constants
- `active_listeners` handling in the callback dispatch

The Rust-side 2Hz throttle replaces all JS-side batching.

- [ ] **Step 12: Update useIOSession.ts if needed**

Check if `useIOSession.ts` has its own listener for `frame-message`. If so, update to `frames-ready`. In most cases, useIOSession doesn't handle frame data directly — it delegates to sessionStore callbacks.

- [ ] **Step 13: Build frontend**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 14: Commit**

```bash
git add -A  # All modified Rust and TS files
git commit -m "feat(ipc): migrate frame-message to frames-ready signal-then-fetch"
```

---

### Task 5: bytes-ready Signal

Replaces `serial-raw-bytes` (session-scoped). Same pattern as frames-ready.

**Files:**
- Modify: `src-tauri/src/io/multi_source/merge.rs` (~line 247, 270: `emit_to_session("serial-raw-bytes", ...)`)
- Modify: `src-tauri/src/io/virtual_device/mod.rs` (~line 598, 661: `emit_to_session("serial-raw-bytes", ...)`)
- Modify: `src/stores/sessionStore.ts` (serial-raw-bytes listener)

- [ ] **Step 1: Rust — replace serial-raw-bytes emissions with bytes-ready signal**

In `merge.rs` (~line 247, 270): Replace `emit_to_session(app, "serial-raw-bytes", session_id, RawBytesPayload { ... })` with:
```rust
if throttle.should_signal("bytes-ready") {
    emit_to_session(&app, "bytes-ready", &session_id, ());
}
```
Bytes are already stored in `buffer_store::append_bytes_to_session` before emission.

Same change in `virtual_device/mod.rs` (~line 598, 661).

For the final drain in both files: `throttle.flush()` then unconditional signal.

- [ ] **Step 2: Frontend — update bytes listener in sessionStore.ts**

Replace the `serial-raw-bytes:${sessionId}` listener:
```typescript
listen(`bytes-ready:${sessionId}`, async () => {
  const eventListeners = getEventListeners()[sessionId];
  if (!eventListeners) return;
  // Resolve bytes buffer ID from session store state (same approach as frames-ready)
  const bufferId = /* resolve bytes buffer ID from session store state */;
  if (!bufferId) return;
  const response = await getBufferBytesTail(bufferId, bytesTailSize);
  if (response.bytes.length > 0) {
    invokeCallbacks(eventListeners, "onBytes", response.bytes);
  }
});
```

- [ ] **Step 3: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate serial-raw-bytes to bytes-ready signal-then-fetch"
```

---

### Task 6: playback-position Signal

Replaces `playback-time` (session-scoped, throttled 2Hz). Timeline readers store position before signalling.

**Files:**
- Modify: `src-tauri/src/io/timeline/buffer.rs` (~7 `emit_to_session("playback-time", ...)` calls)
- Modify: `src-tauri/src/io/timeline/csv.rs` (~3 calls)
- Modify: `src-tauri/src/io/timeline/postgres.rs` (~3 calls)
- Modify: `src/hooks/useIOSession.ts` (playback-time listener)

- [ ] **Step 1: Rust — store playback position then signal**

In each timeline reader, replace all `emit_to_session(app, "playback-time", session_id, position)` with:
```rust
io::store_playback_position(&session_id, position);
if throttle.should_signal("playback-position") {
    emit_to_session(&app, "playback-position", &session_id, ());
}
```

For seek operations (one-shot): skip throttle check, always signal.
On pause/complete: flush throttle, then final signal.

Add `io::clear_playback_position(&session_id)` to the cleanup path (where `stream-ended` is currently emitted, or in `destroy_session`).

- [ ] **Step 2: Frontend — update playback-time listener in useIOSession.ts**

Replace the `playback-time:${sessionId}` listener:
```typescript
listen(`playback-position:${sessionId}`, async () => {
  const position = await getPlaybackPosition(sessionId);
  if (position) {
    setPlaybackPosition(position);
  }
});
```

- [ ] **Step 3: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate playback-time to playback-position signal-then-fetch"
```

---

### Task 7: Eliminate Frontend Batching and active_listeners

Final cleanup for high-frequency signals. Remove all remaining batching infrastructure and the active_listeners mechanism.

**Files:**
- Modify: `src/stores/sessionStore.ts`
- Modify: `src-tauri/src/io/mod.rs` (remove `FrameBatchPayload`, `get_active_listeners_sync`)

- [ ] **Step 1: Remove FrameBatchPayload and active_listeners from Rust**

In `io/mod.rs`:
- Remove `FrameBatchPayload` struct (~line 122-129)
- Remove `get_active_listeners_sync` function (no longer called)
- Remove `get_active_listeners` async function and its Tauri command registration if only used for this purpose

- [ ] **Step 2: Remove batching infrastructure from sessionStore.ts**

Remove all of:
- `accumulateFrames` function (if not already removed in Task 4)
- `flushPendingFrames` function
- `pendingFramesMap` (Map or variable)
- `scheduleFlush` / `flushTimerId` / timer logic
- `BATCH_SIZE_THRESHOLD`, `MIN_FLUSH_INTERVAL_MS`, `MAX_FLUSH_INTERVAL_MS` constants
- Any `active_listeners` filtering in callback dispatch
- The `FrameBatchPayload` type import

- [ ] **Step 3: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "refactor(ipc): remove frame batching and active_listeners mechanism"
```

---

## Chunk 3: Session State Signals

One-shot signals for session state changes. Not throttled (infrequent by nature). Each replaces a payload-bearing emit with an empty signal; the frontend fetches current state via existing or new commands.

### Task 8: session-changed and session-info Signals

**`session-changed`** replaces `session-state` (emitted by `emit_state_change` in `io/mod.rs` ~line 752).
**`session-info`** replaces `speed-changed` (~line 775) and `joiner-count-changed` (~line 770). Not throttled — these emit helpers are called from session management code in `io/mod.rs` (not IO tasks), where no `SignalThrottle` exists. In practice, speed changes are user-initiated and joiner count changes are limited to listener join/leave — both well under 2Hz.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (emit helpers)
- Modify: `src/stores/sessionStore.ts` (session-state, speed-changed, joiner-count-changed listeners)
- Modify: `src/hooks/useIOSession.ts` (session-state, speed-changed, joiner-count-changed listeners)

- [ ] **Step 1: Rust — update emit helpers**

```rust
fn emit_state_change(app: &AppHandle, session_id: &str, _previous: &IOState, _current: &IOState) {
    emit_to_session(app, "session-changed", session_id, ());
}

fn emit_joiner_count_change(app: &AppHandle, session_id: &str, _joiner_count: usize, _listener_id: Option<&str>, _app_name: Option<&str>, _change: Option<&str>) {
    emit_to_session(app, "session-info", session_id, ());
}

fn emit_speed_change(app: &AppHandle, session_id: &str, _speed: f64) {
    emit_to_session(app, "session-info", session_id, ());
}
```

Remove the payload structs (`StateChangePayload`, `JoinerCountChangedPayload`) once all consumers are migrated.

- [ ] **Step 2: Frontend — update listeners**

In `sessionStore.ts`, replace `session-state:${sessionId}` listener:
```typescript
listen(`session-changed:${sessionId}`, async () => {
  const state = await getIOSessionState(sessionId);
  if (state) {
    invokeCallbacks(eventListeners, "onStateChange", state);
  }
});
```

Replace `speed-changed:${sessionId}` and `joiner-count-changed:${sessionId}` listeners with one `session-info:${sessionId}` listener:
```typescript
listen(`session-info:${sessionId}`, async () => {
  const state = await getIOSessionState(sessionId);
  if (state) {
    invokeCallbacks(eventListeners, "onSessionInfo", state);
  }
});
```

In `useIOSession.ts`, update the corresponding listeners similarly — fetch state via invoke instead of reading from the event payload.

- [ ] **Step 3: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate session-state/speed/joiner signals to signal-then-fetch"
```

---

### Task 9: stream-ended, session-error, device-connected Signals

These one-shot signals need the post-session TTL cache (Task 2) because the session may be destroyed before the frontend fetch arrives.

**`stream-ended`** replaces both `stream-ended` and `stream-complete`. Store info in post_session cache before signalling.
**`session-error`** replaces `session-error`. Already stored via `store_startup_error`; also store in post_session cache.
**`device-connected`** replaces `device-connected`. Store source info in post_session cache.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (emit helpers: `emit_stream_ended`, `emit_session_error`, `emit_device_connected`)
- Modify: `src-tauri/src/io/timeline/buffer.rs` (`stream-complete` → `stream-ended`)
- Modify: `src/stores/sessionStore.ts` (listeners)
- Modify: `src/hooks/useIOSession.ts` (listeners)

- [ ] **Step 1: Rust — update emit_stream_ended**

In `emit_stream_ended` (~line 1264-1316): After constructing the metadata, store in post-session cache, then emit signal:
```rust
pub fn emit_stream_ended(app_handle: &AppHandle, session_id: &str, reason: &str, log_prefix: &str) {
    use crate::buffer_store::{self, BufferType};
    // ... existing finalize_session_buffers and metadata construction ...

    // Store in post-session cache for late-arriving fetches
    post_session::store_stream_ended(session_id, post_session::StreamEndedInfo {
        reason: reason.to_string(),
        buffer_available,
        buffer_id: buffer_id.clone(),
        buffer_type: buffer_type.clone(),
        count,
        time_range,
    });

    // Signal only — no payload
    emit_to_session(app_handle, "stream-ended", session_id, ());
    tlog!("[{}:{}] Stream ended (reason: {}, count: {})", log_prefix, session_id, reason, count);
}
```

- [ ] **Step 2: Rust — update emit_session_error**

```rust
pub fn emit_session_error(app: &AppHandle, session_id: &str, error: String) {
    store_startup_error(session_id, error.clone());
    post_session::store_error(session_id, error);
    emit_to_session(app, "session-error", session_id, ());
}
```

- [ ] **Step 3: Rust — update emit_device_connected**

```rust
pub fn emit_device_connected(app: &AppHandle, session_id: &str, device_type: &str, address: &str, bus_number: Option<u8>) {
    post_session::store_source(session_id, post_session::SourceInfo {
        device_type: device_type.to_string(),
        address: address.to_string(),
        bus: bus_number,
    });
    emit_to_session(app, "device-connected", session_id, ());
}
```

- [ ] **Step 4: Rust — replace stream-complete with stream-ended in buffer.rs**

In `buffer.rs`, all `emit_to_session(app, "stream-complete", session_id, "paused")` calls (~lines 405, 806, 859) change to:
```rust
post_session::store_stream_ended(&session_id, post_session::StreamEndedInfo {
    reason: "paused".to_string(),
    buffer_available: true,
    buffer_id: Some(buffer_id.clone()),
    buffer_type: Some("frames".to_string()),
    count: frame_count,
    time_range: /* compute from buffer metadata */,
});
emit_to_session(&app, "stream-ended", &session_id, ());
```

- [ ] **Step 5: Frontend — update stream-ended, session-error, device-connected listeners**

In `sessionStore.ts`:
```typescript
// stream-ended (replaces both stream-ended and stream-complete)
listen(`stream-ended:${sessionId}`, async () => {
  const info = await getStreamEndedInfo(sessionId);
  if (info) {
    invokeCallbacks(eventListeners, "onStreamEnded", info);
  }
});

// session-error
listen(`session-error:${sessionId}`, async () => {
  const error = await getSessionError(sessionId);
  if (error) {
    invokeCallbacks(eventListeners, "onError", error);
  }
});

// device-connected — BREAKING CHANGE: old callback received a single device payload,
// new fetch returns Vec<SourceInfo> (all connected sources for the session).
// Update the onDeviceConnected callback type from single device to sources array.
listen(`device-connected:${sessionId}`, async () => {
  const sources = await getSessionSources(sessionId);
  invokeCallbacks(eventListeners, "onDeviceConnected", sources);
});
```

**Callback type changes required:**
- `onStreamEnded`: receives `StreamEndedInfo` (from `src/api/io.ts`) instead of the old `StreamEndedPayload`. Field names are intentionally similar — verify they match the old callback consumers.
- `onDeviceConnected`: **breaking** — was `(device: DeviceConnectedPayload) => void`, now `(sources: SourceInfo[]) => void`. Update all app handler hooks that implement this callback. The old event was emitted per-device; the new fetch returns all sources at once.

Remove the `stream-complete:${sessionId}` listener (merged into `stream-ended`).

Update `useIOSession.ts` similarly for these three signals.

- [ ] **Step 6: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate stream-ended/session-error/device-connected to signal-then-fetch"
```

---

### Task 10: buffer-changed, session-lifecycle, session-reconfigured Signals

**`buffer-changed`** replaces `buffer-orphaned` and `buffer-created`. Frontend fetches buffer metadata.
**`session-lifecycle`** (session-scoped) replaces `session-suspended`, `session-resuming`, `session-switched-to-buffer`, `session-device-replaced`. Frontend fetches session state.
**`session-reconfigured`** keeps the same name, just drops the payload.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (emit helpers: `emit_buffer_orphaned`, `emit_buffer_created`, `suspend_session`, `resume_session_fresh`, `stop_and_switch_to_buffer`, `replace_session_device`, `reconfigure_session`)
- Modify: `src/stores/sessionStore.ts`
- Modify: `src/hooks/useIOSession.ts`

- [ ] **Step 1: Rust — buffer-changed signal**

Replace `emit_buffer_orphaned` and `emit_buffer_created`:
```rust
pub fn emit_buffer_changed(app: &AppHandle, session_id: &str) {
    emit_to_session(app, "buffer-changed", session_id, ());
}
```

Update callers: `emit_buffer_orphaned(app, sid, orphaned)` → `emit_buffer_changed(app, sid)` (for each orphaned buffer). `emit_buffer_created(app, sid, ...)` → `emit_buffer_changed(app, sid)`.

Remove `BufferOrphanedPayload` and `BufferCreatedPayload` structs.

- [ ] **Step 2: Rust — session-lifecycle signal (session-scoped)**

Replace the four separate session-scoped lifecycle emissions:
```rust
// In suspend_session (~line 2042):
emit_to_session(app, "session-lifecycle", session_id, ());
// was: emit_to_session(app, "session-suspended", session_id, SessionSuspendedPayload { ... })

// In replace_session_device (~line 2130):
emit_to_session(app, "session-lifecycle", session_id, ());
// was: emit_to_session(app, "session-device-replaced", session_id, DeviceReplacedPayload { ... })

// In stop_and_switch_to_buffer (~line 2229):
emit_to_session(app, "session-lifecycle", session_id, ());
// was: emit_to_session(app, "session-switched-to-buffer", session_id, SessionSwitchedToBufferPayload { ... })

// In resume_session_fresh (~line 2301) and resume_to_live_session (~line 2665):
emit_to_session(app, "session-lifecycle", session_id, ());
// was: emit_to_session(app, "session-resuming", session_id, SessionResumingPayload { ... })
```

Remove `SessionSuspendedPayload`, `SessionSwitchedToBufferPayload`, `SessionResumingPayload`, `DeviceReplacedPayload` structs once no longer used.

**Important:** `stop_and_switch_to_buffer` currently emits `session-switched-to-buffer` with `capabilities` in the payload. The frontend needs capabilities after this transition. Since `getIOSessionCapabilities` already exists as an invoke command, the frontend can fetch it separately.

- [ ] **Step 3: Rust — session-reconfigured (drop payload)**

In `reconfigure_session` (~line 2508):
```rust
// was: emit_to_session(app, "session-reconfigured", session_id, serde_json::json!({ "start": ..., "end": ... }));
emit_to_session(app, "session-reconfigured", &session_id, ());
```

- [ ] **Step 4: Frontend — update listeners**

In `sessionStore.ts`:
```typescript
// buffer-changed (replaces buffer-orphaned + buffer-created)
// The old events carried buffer IDs in their payloads. Now the listener must
// resolve buffer IDs from session store state. The session store tracks buffer IDs
// on the session object (e.g., sessions[sessionId].buffer.id). Check how
// setupSessionEventListeners receives buffer info and use the same source.
listen(`buffer-changed:${sessionId}`, async () => {
  const eventListeners = getEventListeners()[sessionId];
  if (!eventListeners) return;
  // Resolve buffer IDs from session store state (NOT from eventListeners)
  const sessionState = get().sessions[sessionId];
  const bufferId = sessionState?.buffer?.id;
  const bytesBufferId = sessionState?.bytesBuffer?.id;
  if (bufferId) {
    const metadata = await getBufferMetadata(bufferId);
    if (metadata) invokeCallbacks(eventListeners, "onBufferChanged", metadata);
  }
  if (bytesBufferId) {
    const metadata = await getBufferMetadata(bytesBufferId);
    if (metadata) invokeCallbacks(eventListeners, "onBytesBufferChanged", metadata);
  }
});

// session-lifecycle (replaces suspended/resuming/switched-to-buffer/device-replaced)
// IMPORTANT: uses session-scoped listen (with :${sessionId} suffix).
// The GLOBAL session-lifecycle signal (for create/destroy) is separate and kept as-is.
listen(`session-lifecycle:${sessionId}`, async () => {
  const state = await getIOSessionState(sessionId);
  const capabilities = await getIOSessionCapabilities(sessionId);
  invokeCallbacks(eventListeners, "onSessionLifecycle", { state, capabilities });
});

// session-reconfigured (no payload)
listen(`session-reconfigured:${sessionId}`, async () => {
  const state = await getIOSessionState(sessionId);
  invokeCallbacks(eventListeners, "onReconfigured", state);
});
```

**Callback type changes required:**
- `onBufferChanged`: was two separate callbacks (`onBufferOrphaned`, `onBufferCreated`). Now one callback receiving `BufferMetadata | null`. Update app handler hooks that implemented the old callbacks.
- `onSessionLifecycle`: **new callback** replacing four old callbacks (`onSuspended`, `onResuming`, `onSwitchedToBuffer`, `onDeviceReplaced`). Add to the callback registration interface:
  ```typescript
  interface SessionCallbacks {
    // ... existing ...
    onSessionLifecycle?: (data: { state: IOState | null; capabilities: IOCapabilities | null }) => void;
  }
  ```
  Update all app handler hooks that implemented the four old callbacks to use the unified one. The handler can distinguish the lifecycle event by inspecting `state.type` (e.g., `"Paused"` for suspend, `"Running"` for resume).

Remove listeners for: `buffer-orphaned`, `buffer-created`, `session-suspended`, `session-switched-to-buffer`, `session-resuming`, `session-device-replaced`.

Update `useIOSession.ts` similarly.

- [ ] **Step 5: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate buffer/lifecycle/reconfigure signals to signal-then-fetch"
```

---

## Chunk 4: Global Signal Migration + Cleanup

### Task 11: transmit-updated Signal

Replaces `transmit-history-updated`. Already an empty payload (`()`) in most call sites. Just needs throttling and a consistent name.

**Files:**
- Modify: `src-tauri/src/transmit.rs` (~10 `app.emit("transmit-history-updated", ())` calls)
- Modify: `src-tauri/src/replay.rs` (~3 calls)
- Modify: `src/apps/transmit/hooks/useTransmitHistorySubscription.ts`

- [ ] **Step 1: Rust — throttle and rename in transmit.rs**

For single-shot transmits (one emit per action), emit unconditionally:
```rust
let _ = app.emit("transmit-updated", ());
```

For repeat loops (currently emit every 250ms), use a `SignalThrottle`:
```rust
if throttle.should_signal("transmit-updated") {
    let _ = app.emit("transmit-updated", ());
}
```

Same for `replay.rs` — the replay task's 250ms progress emit already rate-limits. Replace `app.emit("transmit-history-updated", ())` with `app.emit("transmit-updated", ())`.

- [ ] **Step 2: Rust — rename repeat-stopped**

**`repeat-stopped` split:** This event is emitted from both `replay.rs` (replay operations) and `transmit.rs` (single-frame repeat transmissions). These are logically different operations:
- **`replay.rs`:** `repeat-stopped` → `replay-lifecycle` (empty payload). Frontend fetches via `getReplayState`.
- **`transmit.rs`:** `repeat-stopped` stays as-is. It's infrequent (fires once when a repeat stops) and is not part of the memory leak. The transmit subscription already handles it.

In `replay.rs` only, replace `app.emit("repeat-stopped", RepeatStoppedEvent { ... })` with `app.emit("replay-lifecycle", ())`.

In `transmit.rs`, keep `app.emit("repeat-stopped", ...)` unchanged.

- [ ] **Step 3: Frontend — update transmit subscription**

In `useTransmitHistorySubscription.ts`, the listener already has no payload handling — just update the event name:
```typescript
listen("transmit-updated", () => {
  // re-fetch transmit history
  queryTransmitHistory();
});
```

- [ ] **Step 4: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate transmit-history-updated to transmit-updated signal"
```

---

### Task 12: Replay Signals

**`replay-progress`** replaces `replay-progress` (throttled 2Hz). Frontend fetches via `getReplayState`.
**`replay-lifecycle`** replaces `replay-started`, `replay-loop-restarted` (one-shot). Frontend fetches via `getReplayState`.

**Files:**
- Modify: `src-tauri/src/replay.rs`
- Modify: frontend replay listeners (find via grep for `replay-started`, `replay-progress`, `replay-loop-restarted`)

- [ ] **Step 1: Rust — store replay state and emit signals**

In the replay task:
1. On start: store `ReplayState { status: "running", ... }`, emit `app.emit("replay-lifecycle", ())`
2. On progress (250ms): update state, emit `app.emit("replay-progress", ())` (already rate-limited by the 250ms interval, but use throttle for consistency)
3. On loop restart: update state (increment pass), emit `app.emit("replay-lifecycle", ())`
4. On completion/cancel: update state (status: "stopped"/"completed"), emit `app.emit("replay-lifecycle", ())`

Remove `ReplayStartedEvent`, `ReplayProgressEvent`, `ReplayLoopRestartedEvent` structs.

- [ ] **Step 2: Frontend — update replay listeners**

Replace `replay-started`, `replay-progress`, `replay-loop-restarted` listeners with:
```typescript
listen("replay-progress", async () => {
  const state = await getReplayState(replayId);
  if (state) updateReplayProgress(state);
});

listen("replay-lifecycle", async () => {
  const state = await getReplayState(replayId);
  if (state) handleReplayLifecycle(state);
});
```

- [ ] **Step 3: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate replay events to signal-then-fetch"
```

---

### Task 13: modbus-scan Signal

Replaces `modbus-scan-frame`, `modbus-scan-progress`, `modbus-scan-device-info` (all currently global). Changed to session-scoped `modbus-scan` signal (throttled 2Hz).

**Files:**
- Modify: `src-tauri/src/io/modbus_tcp/scanner.rs`
- Modify: `src-tauri/src/sessions.rs` (scan command wrappers — add session_id parameter)
- Modify: `src/apps/discovery/Discovery.tsx` (merge 3 listeners into 1)

- [ ] **Step 1: Rust — add session_id to scanner functions**

Update `modbus_scan_registers` and `modbus_scan_unit_ids` signatures to include `session_id: Option<String>`. Store scan state accumulating frames/progress/device_info in `SCAN_STATES`.

Replace all `app.emit("modbus-scan-frame", ...)`, `app.emit("modbus-scan-progress", ...)`, `app.emit("modbus-scan-device-info", ...)` with:
```rust
store_scan_state(&session_id, current_state.clone());
if throttle.should_signal("modbus-scan") {
    if let Some(sid) = &session_id {
        emit_to_session(&app, "modbus-scan", sid, ());
    }
}
```

On scan complete: `throttle.flush()` + final signal.

Update `modbus_scan_complete` events similarly.

- [ ] **Step 2: Update sessions.rs command wrappers**

Add `session_id: Option<String>` parameter to the `modbus_scan_registers` and `modbus_scan_unit_ids` Tauri commands. Pass through to the scanner functions.

- [ ] **Step 3: Frontend — merge Discovery.tsx listeners**

Replace the three separate listeners (`modbus-scan-frame`, `modbus-scan-progress`, `modbus-scan-device-info`) with one:
```typescript
listen(`modbus-scan:${sessionId}`, async () => {
  const state = await getModbusScanState(sessionId);
  if (state) {
    updateScanFrames(state.frames);
    updateScanProgress(state.progress);
    updateDeviceInfo(state.device_info);
  }
});
```

Update the scan initiation calls to pass `session_id`.

- [ ] **Step 4: Build both, commit**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit
git commit -am "feat(ipc): migrate modbus-scan events to session-scoped signal-then-fetch"
```

---

### Task 14: Session Log Subscription Updates

Update the session log hooks that listen for session events for logging/display purposes.

**Files:**
- Modify: `src/hooks/useSessionLogSubscription.ts`
- Modify: `src/apps/session-manager/hooks/useSessionLogSubscription.ts`

- [ ] **Step 1: Update event names in both subscription hooks**

Both hooks listen for various session events to log them. Update all event names to match the new signal names:

| Old event | New signal |
|-----------|-----------|
| `session-state:${sid}` | `session-changed:${sid}` |
| `speed-changed:${sid}` | `session-info:${sid}` |
| `joiner-count-changed:${sid}` | `session-info:${sid}` (merge) |
| `stream-ended:${sid}` | `stream-ended:${sid}` (same name) |
| `stream-complete:${sid}` | removed (merged into stream-ended) |
| `session-suspended:${sid}` | `session-lifecycle:${sid}` |
| `session-resuming:${sid}` | `session-lifecycle:${sid}` (merge) |
| `session-switched-to-buffer:${sid}` | `session-lifecycle:${sid}` (merge) |
| `session-device-replaced:${sid}` | `session-lifecycle:${sid}` (merge) |
| `session-error:${sid}` | `session-error:${sid}` (same name) |
| `session-reconfigured:${sid}` | `session-reconfigured:${sid}` (same name) |
| `buffer-orphaned:${sid}` | `buffer-changed:${sid}` |
| `buffer-created:${sid}` | `buffer-changed:${sid}` (merge) |

For merged signals (e.g., multiple old events → one new signal), the log handler now fetches state to determine what happened:
```typescript
listen(`session-lifecycle:${sessionId}`, async () => {
  const state = await getIOSessionState(sessionId);
  addLog(`Session lifecycle change: ${state?.type ?? "unknown"}`);
});
```

- [ ] **Step 2: Build, commit**

```bash
npx tsc --noEmit
git commit -am "feat(ipc): update session log subscriptions for new signal names"
```

---

### Task 15: Final Cleanup and Verification

Remove dead code, unused payload types, and verify the migration is complete.

**Files:**
- Modify: `src-tauri/src/io/mod.rs` (remove unused payload structs)
- Modify: `src/api/io.ts` (remove unused payload types)
- Modify: `src/stores/sessionStore.ts` (final cleanup)

- [ ] **Step 1: Remove unused Rust payload structs**

From `io/mod.rs`, remove structs that are no longer serialised into emit payloads:
- `FrameBatchPayload` (if not already removed in Task 7)
- `StreamEndedPayload` (replaced by `post_session::StreamEndedInfo`)
- `StateChangePayload`
- `JoinerCountChangedPayload`
- `SessionSuspendedPayload`
- `SessionSwitchedToBufferPayload`
- `SessionResumingPayload`
- `DeviceReplacedPayload`
- `BufferOrphanedPayload`
- `BufferCreatedPayload`
- `DeviceConnectedPayload`

Keep any that are still referenced by invoke command return types. Grep before deleting.

- [ ] **Step 2: Remove unused frontend payload types**

From `io.ts` and `sessionStore.ts`, remove TypeScript interfaces for the old payloads:
- `RawBytesPayload` (from io.ts — check if still used)
- Any inline payload types in sessionStore listener callbacks

Update `SessionDataStreams` comments if they reference old event names.

- [ ] **Step 3: Grep for any remaining old event names**

```bash
cd /path/to/WireTAP
grep -rn '"frame-message\|"serial-raw-bytes\|"playback-time\|"session-state\|"speed-changed\|"joiner-count-changed\|"stream-complete\|"session-suspended\|"session-resuming\|"session-switched-to-buffer\|"session-device-replaced\|"buffer-orphaned\|"buffer-created\|"transmit-history-updated\|"replay-started\|"replay-loop-restarted\|"modbus-scan-frame\|"modbus-scan-progress\|"modbus-scan-device-info' src/ src-tauri/src/
```

Expected: No matches except `repeat-stopped` in `transmit.rs` (intentionally kept). Fix any other remaining references.

- [ ] **Step 4: Full build**

```bash
cd src-tauri && cargo build && cd .. && npx tsc --noEmit && npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor(ipc): remove unused payload structs and old event name references"
```

- [ ] **Step 6: Manual verification**

1. Start the app: `npm run tauri dev`
2. Connect a device (or use virtual device) and start streaming
3. Monitor WebView memory via `footprint -p <pid>` — confirm WebKit malloc is stable
4. Verify frame display updates in Discovery and Decoder panels
5. Test playback: open a buffer, play/pause/seek — verify position updates
6. Test serial/bytes: connect a serial device — verify byte display
7. Test transmit: send a frame — verify transmit history updates
8. Stop streaming — verify stream-ended notification appears
9. Test multi-source: connect multiple devices — verify merge works
10. Test modbus scan (if hardware available): verify scan progress and results

---

## Implementation Notes

### Callback Interface Compatibility

The signal-then-fetch migration changes how data arrives (from event payload to invoke response), but the callback interfaces (`onFrames`, `onBytes`, `onStateChange`, etc.) in sessionStore should remain stable. Components that register callbacks through `useIOSessionManager` should not need changes — the migration is internal to sessionStore and useIOSession.

If a callback's type signature changes (e.g., `onStreamEnded` now receives `StreamEndedInfo` instead of `StreamEndedPayload`), update the callback type definition and any app-specific handlers that consume it. The field names in `StreamEndedInfo` are intentionally similar to the old `StreamEndedPayload` to minimise downstream changes.

### Ordering of Signal Registration

Frontend listeners must be registered BEFORE the session is started. This is already the case — `setupSessionEventListeners` runs during session creation, before `start_reader_session` is called. No change needed.

### Error Handling in Fetch Callbacks

If an invoke fetch fails (e.g., session destroyed between signal and fetch), the callback should silently skip. The `async () => { ... }` pattern naturally handles this — if `getIOSessionState` returns null, the callback doesn't fire. For post-session-cache-backed fetches (`getStreamEndedInfo`, `getSessionError`), the TTL cache ensures data is available for at least 10 seconds after storage.

### Concurrent Fetch Deduplication

With 2Hz throttling, the frontend makes at most 2 fetch calls per second per signal. This is well within Tauri's IPC throughput. No deduplication needed.

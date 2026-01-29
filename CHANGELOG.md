# Changelog

All notable changes to CANdor will be documented in this file.

## [0.3.0] - 2026-01-29

### Added

- **SocketCAN Optional Interface Configuration** (Linux): SocketCAN profiles now support optional bitrate configuration. When a bitrate is selected, CANdor automatically configures the interface using `pkexec` (polkit) for privilege escalation, running `ip link set` commands to bring down the interface, set the bitrate, and bring it back up. When no bitrate is set, the interface is used as already configured by the system. This eliminates the need for manual terminal commands in most cases while preserving flexibility for pre-configured setups.
- **Buffer Frame Stepping**: Step forward and backward through buffer frames one at a time using the step buttons in the playback controls. Stepping respects the current frame ID filter, skipping to the next/previous frame that matches. Step buttons are disabled at buffer boundaries (start/end).
- **Current Frame Highlighting**: During buffer playback or stepping, the current frame is highlighted in the frame table with a cyan ring. The view automatically scrolls to keep the highlighted frame visible.
- **Frame Index Display**: Hovering over a frame row shows "Frame N" in the tooltip, indicating its position in the buffer. Clicking a row selects that frame and seeks to its timestamp.
- **GVRET Interface Configuration**: GVRET profiles (TCP and USB) now support per-interface configuration in Settings. After saving a profile, click "Probe Device" to detect available interfaces. Each interface can be enabled/disabled and configured for CAN or CAN FD protocol. The backend reads this configuration when creating sessions, using the correct protocol traits for each bus. Profiles without interface configuration continue to work with a single default bus for backward compatibility.
- **Interface-Level Trait System**: Formalised traits at the interface level with validation. Each interface (bus mapping) now has explicit traits: `TemporalMode` (realtime/timeline), `Protocol` (can/canfd/modbus/serial), `can_transmit`, and a human-readable `interface_id` (e.g., "can0", "serial1"). Sessions validate trait compatibility when combining multiple interfaces - temporal modes must match, timeline sessions are limited to 1 interface, and protocols must be compatible (CAN + CAN-FD OK, but not CAN + Serial). This enables future support for devices with mixed interface types (e.g., 2 CAN + 2 Serial interfaces).
- **Serial Multi-Bus Support**: Serial interfaces can now be combined in multi-bus sessions alongside other serial ports. Supports full framing (SLIP, Modbus RTU, delimiter-based) with raw bytes visible in the Bytes tab when using Raw framing mode.
- **SocketCAN CAN FD Support** (Linux): SocketCAN interfaces now support CAN FD frames with payloads up to 64 bytes. The backend automatically detects FD frames and sets `is_fd: true`. Transmission of FD frames with BRS (bit rate switch) is also supported.

### Fixed

- **gs_usb Safe Byte Parsing**: Replaced all unsafe `transmute` and `read_unaligned` calls in the gs_usb driver with safe `from_bytes()` constructors. The `GsHostFrame` and `GsDeviceConfig` structs now provide safe parsing methods that validate buffer length before constructing values from little-endian bytes.
- **Mutex Poisoning Handling**: Replaced `.lock().unwrap()` calls in slcan and serial readers with proper error propagation. Init closures return errors, transmit loops send error responses to callers, and read loops emit stream-ended events before breaking. Prevents panic propagation when a mutex is poisoned.
- **gs_usb Codec Error Handling**: Replaced `.try_into().unwrap()` in gs_usb codec with `.map_err()` + `?`, properly propagating byte slice conversion errors instead of panicking.
- **Serial Task Panic Recovery**: Added stream-ended emission after `spawn_blocking` panic in serial reader. If the blocking read task panics, the session now correctly emits a stream-ended event so the frontend can recover.
- **Multi-Source Stop Panic Logging**: Added logging when tasks panic during multi-source reader shutdown, aiding debugging of unexpected task failures.
- **slcan Line Buffer Truncation Logging**: Added logging when slcan line buffer exceeds 64 bytes and is discarded, helping diagnose protocol framing issues.
- **Stale Closure in Profile Reinitialise**: Fixed stale `effectiveProfileName` closure in `useIOSession` when switching profiles. The reinitialise function now uses the provided `newProfileId` parameter when available, ensuring the correct profile name is used.
- **Watch Session Error Handling**: Added try/catch to `handleDialogStartIngest` in Discovery, matching the error handling pattern used in multi-source watch. Errors now display in a dialog instead of being silently swallowed.
- **Watch Frame Count Reset**: Fixed watch frame count not resetting to zero when a stream ends. The `resetWatchFrameCount()` function is now called when `isStreaming` transitions to false while watching.

- **Serial Frame ID Extraction for Multi-Source Sessions**: Fixed frame ID extraction not working for serial sources in multi-bus sessions. The frame ID config from the catalog (`[meta.serial.fields.id]` mask) was not being passed through the multi-source session chain. Now the catalog's frame ID extraction settings (start_byte, num_bytes, byte_order) are properly passed from the frontend through `useIOSessionManager` to the Rust backend's multi-source spawner. Additionally fixed two related issues: (1) stale closure issue where changing the catalog after selecting an IO reader would not update the session handlers - `serialConfig` is now read directly from the store via `getState()` at call time; (2) loading a catalog while streaming now works seamlessly - the frontend extracts frame IDs directly from raw bytes using the catalog config, so no session restart is needed.
- **Signal Edit Dialog Validation**: Fixed "Update Signal" button not working in the Catalog Editor. Integer fields (`start_bit`, `bit_length`) were failing `Number.isInteger()` validation when values came through as strings from TOML parsing. Added type coercion in validation, form handlers, and input handlers.
- **String Signal Bit Length Limit**: Increased maximum `bit_length` for string format signals (UTF-8, ASCII, hex) from 64 to 2048 bits (256 bytes), allowing longer string signals like VIN numbers to be defined.
- **BitPreview Infinite Render Loop**: Fixed "Maximum update depth exceeded" error in the Signal Edit Dialog's bit preview. The `onColorMapping` callback was causing an infinite loop because inline functions passed from parent components created new references on every render. Now uses a ref to store the callback, breaking the dependency cycle.
- **GVRET Probe Default Bus Count**: Fixed GVRET device probing defaulting to 5 buses when the device doesn't respond to the NUMBUSES query. Now defaults to 1 bus, which is safer for single-bus devices.
- **Decoder Frame Matching on Session Start**: Fixed issue where starting an IO session from the Decoder would cause frames to never match the catalog. The `clearFrames` function was incorrectly clearing the catalog frame definitions along with session data. Now only session/buffer data is cleared, preserving the loaded catalog.
- **Multi-Window Session ID Collision**: Fixed potential session ID collision when multiple windows of the same app type (e.g., two Decoder windows) start multi-bus sessions. Session IDs are now generated dynamically using the pattern `{protocol}_{shortId}` (e.g., `can_a7f3c9`) instead of the fixed `{appName}-multi` pattern. Single-bus devices (gs_usb, slcan, etc.) now properly include interface traits in their bus mappings, enabling accurate protocol detection for session naming.
- **IO Reader Picker Selection Conflict**: Fixed issue where selecting a GVRET interface then a serial interface would cause the serial interface to probe forever. The dialog now clears multi-bus selection (`checkedReaderIds`) when selecting a single profile, ensuring mutual exclusivity between single-select and multi-select modes.

### Changed

- **Release Script Changelog Validation**: The release script (`scripts/release.js`) now validates the changelog before releasing. It checks for either a version-specific section (e.g., `## [0.2.34]`) or an `[Unreleased]` section with content. If an `[Unreleased]` section exists, it's automatically renamed to the new version with today's date. The script displays the changelog content for review and prompts for confirmation before proceeding.
- **Deduplicated Buffer Profile Detection**: Consolidated duplicate `isBufferProfileId()` implementations into a single canonical function in `sessionStore.ts`. The function now accepts `string | null` and is re-exported from `useIOSessionManager` for backward compatibility.
- **Removed Unused Rust Method**: Deleted `IOCapabilities::get_data_streams()` which was never called. The frontend's `getDataStreams()` helper handles this logic.

- **Simplified Playback State**: Consolidated "stopped" and "paused" into a single "paused" state. The stop button now behaves identically to pause, simplifying the playback state machine. Both show the square icon and allow stepping through frames.
- **IO Reader Picker Release Button**: The Release button is now positioned inline with action buttons (Watch, Ingest, Join Session, etc.) instead of appearing in a separate row above them. This provides a more compact layout.
- **IO Module Refactoring**: Internal code organisation improvements including unified `TransmitRequest` type, consolidated GVRET probe logic via shared `parse_numbuses_response()` helper, and new `traits.rs`/`types.rs` modules for better separation of concerns.
- **Structured IO Errors**: Replaced string-based IO errors with a typed `IoError` enum. Error variants include Connection, Timeout, Protocol, Transmission, Configuration, DeviceNotFound, DeviceBusy, Read, and Other. All drivers (gvret_tcp, gvret_usb, slcan, socketcan, gs_usb) now use structured errors with device context for better diagnostics. Backwards compatible via `From<IoError> for String`.
- **IO Driver Directory Structure**: Reorganised IO drivers into directory-based modules. Each driver (gvret, slcan, socketcan, gs_usb, serial, mqtt, timeline) is now a directory containing `mod.rs`, `codec.rs` (where applicable), and implementation files. Added unified `FrameCodec` trait in `io/codec.rs` for consistent encode/decode operations across all protocols.
- **Multi-Source Reader Modularisation**: Split `multi_source.rs` (1,112 lines) into a directory-based module with focused submodules: `types.rs` (SourceConfig, TransmitRoute), `merge.rs` (frame merging and event emission), `spawner.rs` (per-protocol reader spawning), and `mod.rs` (MultiSourceReader struct and IODevice implementation).
- **Serial Profile Parsing Extraction**: Moved serial IOProfile parsing from `multi_source/spawner.rs` into `serial/utils.rs` as `parse_profile_for_source()`. This keeps serial-specific configuration logic in the serial module and reduces spawner.rs from 469 to 260 lines.
- **Centralised Session Switching in useIOSessionManager**: Moved session switching orchestration (profile selection, multi-bus state, watch lifecycle, playback speed) from per-app handler hooks into `useIOSessionManager`. New manager methods: `watchSingleSource`, `watchMultiSource`, `stopWatch`, `selectProfile`, `selectMultipleProfiles`, `joinSession`, `skipReader`. Apps provide callbacks (`onBeforeWatch`, `onBeforeMultiWatch`, `setPlaybackSpeed`) for app-specific cleanup. Deleted dead `useIOSessionHandlers.ts` and renamed `useBufferSessionHandler` to `useBufferSession` for naming consistency.
- **First-Class Bytes and Frames Session Model**: Refactored session architecture to treat byte streams (serial) and frame streams (CAN) as peer data types instead of CAN-centric with serial bolted on. Key changes:
  - Renamed `can-bytes-error` event to `session-error` across all emitters and listeners — the event was never CAN-specific.
  - Moved `emit_stream_ended()` from `gvret/common.rs` to shared `io/mod.rs`, eliminating the duplicate in `serial/reader.rs`. All drivers now import from the shared location.
  - Renamed `SourceMessage::RawBytes` to `SourceMessage::Bytes` and `RawByteEntry` to `ByteEntry`. Aligned `timestamp_us` to `u64` (was `i64`), removing a cast in merge.rs.
  - Added `SessionDataStreams { emits_frames, emits_bytes }` to `IOCapabilities` — each device formally declares what data streams it produces. Multi-source derives streams from constituents. Frontend helper `getDataStreams()` provides legacy fallback.
  - Routed raw bytes through `sessionStore` via new `onBytes` callback in `SessionCallbacks`, eliminating the ad-hoc `listen()` in Discovery.tsx. Bytes now go through the same centralised event listener and callback routing system as frames.
  - Unified `transmit_frame()` and `transmit_serial()` into a single `transmit(payload: TransmitPayload)` method on `IODevice`, where `TransmitPayload` is `CanFrame(CanTransmitFrame) | RawBytes(Vec<u8>)`. Adding new transport types (Modbus write, SPI) no longer requires new trait methods.
  - Relaxed protocol group isolation in `traits.rs` — removed `protocol_group()` function. Any protocol combination is now valid in multi-source sessions as long as temporal modes match (e.g., CAN + serial debug port). `SessionDataStreams` handles the distinction.

## [0.2.33] - 2026-01-24

### Added

- **Multi-Window Support**: Open multiple CANdor windows via View → New Window (Cmd+N). Each window maintains its own independent tab layout.
- **Per-Window Tab Persistence**: Each window remembers its open tabs and layout. Tabs are restored when the window reopens.
- **Window State Persistence**: Window size and position are automatically saved and restored on relaunch.
- **Session Restore**: All open windows are restored when relaunching CANdor, each with their saved tabs, size, and position.
- **Timezone Display Setting**: New "Default timezone" option in Settings → Display allows choosing between Local and UTC for clock displays. Clock displays in Decoder and Discovery now show a clickable badge (Local/UTC) that cycles through timezone options without changing the global setting.
- **Date Display for Recorded Sources**: Clock displays now show both date and time when viewing recorded data (PostgreSQL, CSV, buffers), while live sources show time only.
- **Second-Precision Bookmarks**: Bookmark time inputs now support second-level precision. Previously bookmarks were limited to minute granularity.
- **Session Joining for Recorded Sources**: Active PostgreSQL sessions now appear in the IO Reader Picker's "Active Sessions" section, allowing other apps (e.g., Decoder) to join an existing streaming session from Discovery. Previously only multi-bus sessions were shown as joinable.
- **Centralized Bookmark Button**: The bookmark picker button is now part of the session controls (next to play/stop) in Decoder and Discovery top bars. The button only appears when the data source supports time range filtering (e.g., PostgreSQL), and is disabled while streaming since time range cannot be changed mid-stream.
- **Discovery Speed Picker**: The playback speed button is now visible in the Discovery top bar when using recorded sources (PostgreSQL). Previously only available in Decoder.
- **Continue Without Reader**: IO Reader Picker dialog now shows a "Continue Without Reader" button when no reader is selected, allowing users to set up Transmit frames before connecting to a device.

### Fixed

- **Ingest Frame Count NaN**: Fixed "Ingesting: NaN frames" display in the IO Reader Picker dialog when ingesting from PostgreSQL and other sources using the new frame batch payload format. The frame message listener now handles both legacy array format and the newer `FrameBatchPayload` object format.
- **Panel Scroll Overflow**: Fixed app panels scrolling beyond their boundaries and going underneath the title bar on macOS. Root html/body elements now use `position: fixed` and `overscroll-behavior: none` to completely lock the webview in place. App components use `h-full` instead of `h-screen`, a centralized `PanelWrapper` ensures proper height constraints, and scroll containers use `overscroll-none`.
- **Decoder Unlimited Speed Playback**: Fixed issue where the Decoder would not show decoded signals when playing back from PostgreSQL at unlimited speed (0x). Frames are now flushed immediately when stream ends, ensuring all frames are processed before completion.
- **Second-Precision Bookmark Timestamps**: Fixed PostgreSQL queries failing when using bookmarks with second-precision timestamps. The timestamp format was being double-suffixed (e.g., `09:04:20:00` instead of `09:04:20`).
- **Watch Mode Playback Pacing**: Fixed IO Reader Picker defaulting to unlimited speed (0x) for Watch mode instead of 1x realtime. Watch now correctly defaults to 1x with pacing enabled, ensuring recorded data plays back at the intended speed.
- **IO Reader Picker Selection Stability**: Fixed data source selection being cleared when changing watch speed in the IO Reader Picker dialog. The issue was caused by a new empty array being created on each re-render, triggering the dialog's initialization effect.
- **Discovery Speed Picker Dialog**: Fixed speed picker in Discovery showing a "Change Speed Mode?" warning dialog instead of the speed picker. Discovery now uses the same SpeedPickerDialog as Decoder, with the confirmation dialog only appearing when switching from No Limit mode with frames present.
- **Cross-Window Speed Synchronization**: Fixed playback speed not syncing between windows when apps share a session. When Discovery changes speed while Decoder is viewing the same PostgreSQL session, Decoder's speed display now updates automatically. The backend now emits `speed-changed` events and apps subscribe via `onSpeedChange` callback.
- **Discovery Protocol Badge Case**: Fixed protocol badge showing lowercase "can" in Discovery. Now displays uppercase "CAN" to match Decoder.
- **Transmit Top Bar Styling**: Fixed Transmit icon color (blue→red) to match the tab icon, and added separator after icon for consistency with Decoder and Discovery.
- **Transmit Protocol Badge Label**: Fixed protocol badge losing its text when IO session is stopped. Now defaults to "CAN" or "Serial" based on the active tab when no session is connected.

### Changed

- **Shared Protocol Badge Component**: Extracted protocol badge (with status light, protocol label, recorded indicator) into reusable `ProtocolBadge` component. Now used consistently across Decoder, Discovery, and Transmit. The badge is clickable for future protocol configuration features.
- **Transmit View Styling**: Transmit now has the same dark-themed tab bar style as Decoder and Discovery, with a protocol badge showing streaming status and "CAN" or "Serial" label based on the connected device's capabilities.
- **Simplified View Menu**: The View menu now contains only "New Window" and "Enter Fullscreen". App shortcuts (Dashboard, Decoder, Discovery, etc.) have been removed in favor of using the logo menu within windows.
- **Centralized IO Session Management**: Added `useIOSessionManager` hook to consolidate common IO session patterns (profile state, multi-bus coordination, derived state, detach/rejoin handlers). Transmit app now uses this hook, reducing code duplication and establishing a pattern for incremental adoption by other apps.
- **Unified Session Architecture**: All real-time device sessions (GVRET, slcan, gs_usb, SocketCAN) now use the same internal `MultiSourceReader` path, even for single-device sessions. This simplifies the codebase by eliminating duplicate code paths (~500 lines) while maintaining the same external API. Single-device sessions are now implemented as multi-device sessions with n=1.
- **PostgreSQL No-Limit Batch Size**: Reduced from 1000 to 50 frames per batch to match frontend throttling thresholds, improving decoder responsiveness during fast playback.
- **Dialog State Management**: Added `useDialogManager` hook to consolidate multiple `useState` pairs for dialog visibility into a single hook call. Decoder and Discovery now use this hook, reducing boilerplate and providing a cleaner API (`dialogs.xxx.open()`, `dialogs.xxx.close()`, `dialogs.xxx.isOpen`).
- **Unified IO Session Controls**: Introduced `IOSessionControls` component that combines reader button, speed picker, bookmark button, and session action buttons (stop/resume/detach/rejoin) into a single reusable component. All three apps (Decoder, Discovery, Transmit) now use this unified component for consistent session control layout.
- **Removed No Limit Mode**: Removed the "No Limit" (0x) playback speed option from Discovery. This mode was intended for fast ingestion but added complexity. Users should now use the standard speed options (0.25x to 60x) for playback. The `PlaybackSpeed` type is now centralized in `TimeController` component.

## [0.2.32] - 2026-01-22

### Added

- **Serial Transmit**: Added support for transmitting raw bytes through serial port connections. The Serial tab in the Transmit app now supports:
  - Single-shot byte transmission with optional SLIP or delimiter framing
  - Repeat transmission from the queue at configurable intervals
  - Full history logging for transmitted bytes
- **Multi-Bus Capture**: Support for combining multiple real-time devices into a single merged session. Select multiple sources in the IO Reader Picker using the new "Multi-Bus" toggle. Each source can be configured with:
  - Per-bus enable/disable toggles to filter unwanted buses (for GVRET multi-bus devices)
  - Output bus remapping to assign unique bus numbers across devices
  - Auto-sequential bus number assignment when adding sources
  - Warning indicators when duplicate output bus numbers are configured
- **Unified Device Probing**: All real-time devices (GVRET, slcan, gs_usb, SocketCAN, Serial) are now probed when selected to confirm they're online and healthy. Shows device status and allows bus number configuration.
- **Single-Bus Device Configuration**: When selecting a single-bus device (slcan, gs_usb, etc.) in the IO Reader Picker, you can now configure the output bus number for multi-bus capture scenarios.
- **Multi-Bus Session Sharing**: Active multi-bus sessions now appear in the IO Reader Picker for other apps (e.g., Decoder) to join. When Discovery creates a multi-bus session, it's shown in the "Active Multi-Bus Sessions" section so other apps can receive the same merged frame stream.
- **Discovery Multi-Bus Indicator**: The Discovery top bar now shows "Multi-Bus (N)" with a merge icon when a multi-source session is active, replacing the previous "No reader" display.
- **Multi-Bus Transmit Support**: Transmit app now supports multi-bus sessions. When connected to a multi-bus session, frame transmission is routed to the appropriate source device based on the target bus number. Bus numbers are mapped back to the correct device bus for transmission.
- **Transmit History**: Repeat transmissions (individual and group) now appear in the Transmit History tab. Each frame sent during a repeat cycle is logged with timestamp, success/error status, and frame details.

### Fixed

- **Serial Reconnection**: Fixed issue where serial ports (slcan, serial) could not be reconnected after disconnecting. Two issues were addressed:
  1. Profile tracker not being cleaned up when sessions auto-destroyed via listener unregistration
  2. Transmit app's Stop button now properly leaves the session to release single-handle devices

### Changed

- **sbrxxx.toml**: Updated Sungrow decoder catalog to v3.
- **Transmit Default Interval**: Changed the default repeat transmit interval from 100ms to 1000ms.
- **Adaptive Frame Flushing**: Frame delivery now uses adaptive timing instead of fixed 100ms intervals. Frames are flushed when either 50 frames accumulate (for high-frequency buses) or after 50ms (for low-frequency data). This reduces latency for sparse data while maintaining UI performance under heavy load.
- **Dedicated Transmit Tasks**: GVRET TCP and gs_usb drivers now use dedicated transmit tasks that run independently of the read loop. This ensures consistent transmit timing regardless of incoming traffic volume, fixing issues where transmits could be delayed by 2+ seconds during heavy bus activity.
- **Improved Repeat Transmit Timing**: Repeat transmit now sends the first frame immediately and only starts the interval timer after the first successful transmission. Permanent errors (device disconnected, session not found) stop the repeat and notify the UI.
- **Transmit History Timestamps**: History tab now honors the display time format setting (human, timestamp, delta-start, delta-last) consistent with Discovery.
- **Transmit Bus Display**: Bus numbers in Transmit Queue and History views now show generic "Bus 0", "Bus 1" labels instead of GVRET-specific names, consistent with multi-bus mode where devices are mixed.

## [0.2.31] - 2026-01-15

### Fixed

- **64-bit Signal Decoding**: Fixed signals with bit_length > 32 being truncated due to JavaScript's 32-bit bitwise operator limitation. Now uses BigInt for extraction and formatting of large signals.

### Changed

- **sbrxxx.toml**: Updated Sungrow decoder catalog.
- **Release Script**: Now runs `cargo check` to update Cargo.lock before committing version bump.

## [0.2.30] - 2026-01-14

### Added

- **Update Checker**: App now checks for updates on launch and displays an amber indicator in the menu bar when a newer version is available. Clicking the indicator opens the GitHub release page.
- **gs_usb Support**: Added support for candleLight/CANable devices with gs_usb firmware on Windows, macOS, and Linux. On Linux, devices appear as SocketCAN interfaces; on Windows and macOS, direct USB access via nusb userspace driver. Supports all standard CAN bitrates (10K-1M).
- **MQTT Reader**: Added MQTT broker support for receiving CAN frames. Supports SavvyCAN JSON format with optional CAN FD. Configure host, port, credentials, and subscription topic in Settings.

### Fixed

- **gs_usb Device Selection**: Fixed device picker not updating when selecting a gs_usb device. The issue was caused by stale closures when multiple connection fields were updated in a single event handler.
- **gs_usb Categorization**: gs_usb profiles now correctly appear under "Real-time" in the Data Source picker instead of "Recorded".

## [0.2.29] - 2026-01-13

### Fixed

- **Decoder**: Fixed stale session restart when switching IO profiles. When switching from one GVRET endpoint to another, the old session was incorrectly being restarted due to a stale closure capturing the previous session ID. The Decoder now correctly relies on the backend's auto-start behavior after reinitializing a session.

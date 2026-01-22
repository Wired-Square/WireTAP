# Changelog

All notable changes to CANdor will be documented in this file.

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

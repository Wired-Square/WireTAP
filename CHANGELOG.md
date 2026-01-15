# Changelog

All notable changes to CANdor will be documented in this file.

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

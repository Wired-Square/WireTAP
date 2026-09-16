// crates/wiretap-app/src/io/gs_usb/mod.rs
//
// gs_usb (candleLight firmware) support for WireTAP.
//
// This module provides support for CAN adapters running candleLight firmware,
// which implements the gs_usb protocol. This is the same protocol used by the
// Linux kernel's gs_usb driver.
//
// Platform strategy:
// - Linux: Devices appear as SocketCAN interfaces via kernel gs_usb driver.
//          We enumerate devices and help users configure the interface.
// - Windows/macOS: Direct USB access via nusb crate (no kernel driver available).
//
// Supported devices:
// - CANable (candleLight firmware)
// - CANable Pro
// - Geschwister Schneider USB/CAN
// - Other gs_usb-compatible devices

// Allow dead_code for protocol constants/structures that are only used on specific platforms
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod nusb_driver;

// Re-export multi-source streaming functions
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use nusb_driver::{encode_frame, run_source};

// ============================================================================
// Protocol
// ============================================================================
//
// The wire itself — the identity, the layouts and the bit timing maths — is
// `wiretap_protocol::gs_usb`, re-exported so the driver and the Tauri commands
// below reach it through this module rather than each importing the crate.

pub use wiretap_protocol::gs_usb::{
    bittiming_for_bitrate, calculate_bittiming, can_feature, can_mode, encode_host_frame,
    parse_host_frame, Bittiming, BittimingConstraints, Breq, BtConst, BtConstExtended,
    DeviceConfig, HostFrame, Mode, CLASSIC_FRAME_BYTES, ECHO_ID_RX, HOST_FORMAT,
    PERMISSIVE_CONSTRAINTS, PIDS, VID,
};

// ============================================================================
// Configuration Types
// ============================================================================

/// gs_usb reader configuration
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GsUsbConfig {
    /// USB bus number (for device identification, fallback if serial not available)
    pub bus: u8,
    /// USB device address (for device identification, fallback if serial not available)
    pub address: u8,
    /// USB serial number (preferred device identifier - stable across reconnects)
    #[serde(default)]
    pub serial: Option<String>,
    /// CAN bitrate in bits/second (e.g., 500000)
    pub bitrate: u32,
    /// Sample point as percentage (e.g., 87.5 for 87.5%).
    /// Common values: 75.0, 80.0, 87.5. Default is 87.5%.
    /// Earlier sample points are more robust against oscillator jitter.
    /// Later sample points allow longer cable lengths.
    #[serde(default = "default_sample_point")]
    pub sample_point: f32,
    /// Listen-only mode (no ACK, no transmit)
    pub listen_only: bool,
    /// CAN channel (usually 0)
    #[serde(default)]
    pub channel: u8,
    /// Maximum frames to read (None = unlimited)
    pub limit: Option<i64>,
    /// Display name
    pub display_name: Option<String>,
    /// Bus number override - assigns a specific bus number to all frames from this device.
    /// Used for multi-bus capture where multiple single-bus devices are combined.
    /// If None, defaults to the channel number.
    #[serde(default)]
    pub bus_override: Option<u8>,
    /// Enable CAN FD mode.
    /// Requires an FD-capable device and bus.
    #[serde(default)]
    pub enable_fd: bool,
    /// CAN FD data phase bitrate in bits/second (e.g., 2000000 for 2 Mbit/s).
    /// Only used when enable_fd is true.
    #[serde(default = "default_data_bitrate")]
    pub data_bitrate: u32,
    /// Data phase sample point as percentage (e.g., 75.0 for 75%).
    /// Common values: 60.0, 70.0, 75.0, 80.0. Default is 75.0%.
    /// Lower sample points are recommended for higher data rates.
    #[serde(default = "default_data_sample_point")]
    pub data_sample_point: f32,
    /// Override the CAN clock frequency reported by the device (Hz).
    /// Use when firmware reports an incorrect clock (e.g., reports 160 MHz but
    /// the actual CAN peripheral clock is 170 MHz).
    #[serde(default)]
    pub can_clock_override: Option<u32>,
}

fn default_sample_point() -> f32 {
    87.5
}

fn default_data_bitrate() -> u32 {
    2_000_000
}

fn default_data_sample_point() -> f32 {
    75.0
}

impl Default for GsUsbConfig {
    fn default() -> Self {
        Self {
            bus: 0,
            address: 0,
            serial: None,
            bitrate: 500_000,
            sample_point: 87.5,
            listen_only: true,
            channel: 0,
            limit: None,
            display_name: None,
            bus_override: None,
            enable_fd: false,
            data_bitrate: 2_000_000,
            data_sample_point: 75.0,
            can_clock_override: None,
        }
    }
}

/// Information about a detected gs_usb device
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GsUsbDeviceInfo {
    /// USB bus number
    pub bus: u8,
    /// USB device address
    pub address: u8,
    /// Product name from USB descriptor
    pub product: String,
    /// Serial number (if available)
    pub serial: Option<String>,
    /// SocketCAN interface name (Linux only, e.g., "can0")
    pub interface_name: Option<String>,
    /// Whether the interface is currently up (Linux only)
    pub interface_up: Option<bool>,
}

/// Result of probing a gs_usb device
#[derive(Clone, Debug, Serialize)]
pub struct GsUsbProbeResult {
    pub success: bool,
    /// Number of CAN channels on device
    pub channel_count: Option<u8>,
    /// Software version
    pub sw_version: Option<u32>,
    /// Hardware version
    pub hw_version: Option<u32>,
    /// CAN clock frequency (for bitrate calculation)
    pub can_clock: Option<u32>,
    /// Whether device supports CAN FD
    pub supports_fd: Option<bool>,
    /// Error message if probe failed
    pub error: Option<String>,
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// List all gs_usb devices connected to the system.
/// On Linux, includes the SocketCAN interface name if the device is bound.
#[tauri::command]
pub fn list_gs_usb_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    #[cfg(target_os = "linux")]
    {
        linux::list_devices()
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nusb_driver::list_devices()
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        Ok(vec![])
    }
}

/// Generate the shell command to set up a CAN interface on Linux.
/// Returns the command the user should run with sudo.
#[tauri::command]
pub fn get_can_setup_command(interface: String, bitrate: u32) -> String {
    format!(
        "sudo ip link set {} up type can bitrate {}",
        interface, bitrate
    )
}

/// Probe a gs_usb device to get its capabilities.
/// Implemented for Windows and macOS (Linux uses SocketCAN).
/// Uses serial number for stable device matching across USB re-enumeration.
#[tauri::command]
pub fn probe_gs_usb_device(
    bus: u8,
    address: u8,
    serial: Option<String>,
) -> Result<GsUsbProbeResult, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nusb_driver::probe_device(bus, address, serial.as_deref()).map_err(String::from)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (bus, address, serial);
        Err("Device probing is only available on Windows/macOS. On Linux, use ip link show to check interface status.".to_string())
    }
}

// ============================================================================
// Tests
// ============================================================================

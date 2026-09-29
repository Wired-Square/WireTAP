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
// - Windows/macOS: Direct USB access through wiretap-io (no kernel driver available).
//
// Supported devices:
// - CANable (candleLight firmware)
// - CANable Pro
// - Geschwister Schneider USB/CAN
// - Other gs_usb-compatible devices

// Allow dead_code for protocol constants/structures that are only used on specific platforms
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod nusb_driver;

// Re-export multi-source streaming functions
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use nusb_driver::run_source;

// ============================================================================
// Protocol
// ============================================================================
//
// The identity and the layouts are `wiretap_protocol::gs_usb`, re-exported so
// the diagnostic CLI reaches them through this module rather than importing the
// crate.

pub use wiretap_protocol::gs_usb::{can_feature, Breq, BtConst, DeviceConfig, PIDS, VID};

// ============================================================================
// Configuration Types
// ============================================================================

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

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
impl From<wiretap_io::can::gsusb::GsUsbDevice> for GsUsbDeviceInfo {
    fn from(dev: wiretap_io::can::gsusb::GsUsbDevice) -> Self {
        Self {
            bus: dev.bus,
            address: dev.address,
            product: dev.product,
            serial: dev.serial,
            interface_name: None,
            interface_up: None,
        }
    }
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
        let devices = wiretap_io::can::gsusb::devices()
            .map_err(|e| format!("Failed to list gs_usb devices: {e}"))?;
        Ok(devices
            .into_iter()
            .map(|d| GsUsbDeviceInfo {
                interface_name: d.interface,
                interface_up: d.up,
                ..d.device.into()
            })
            .collect())
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
pub async fn probe_gs_usb_device(
    bus: u8,
    address: u8,
    serial: Option<String>,
) -> Result<GsUsbProbeResult, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nusb_driver::probe_device(bus, address, serial).await
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

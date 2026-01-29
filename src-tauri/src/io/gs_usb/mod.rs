// src-tauri/src/io/gs_usb/mod.rs
//
// gs_usb (candleLight firmware) support for CANdor.
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

pub mod codec;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod nusb_driver;

// Re-export multi-source streaming functions
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use nusb_driver::{encode_frame, run_source};

// ============================================================================
// USB Constants
// ============================================================================

/// OpenMoko Vendor ID (used by candleLight devices)
pub const GS_USB_VID: u16 = 0x1d50;

/// Known gs_usb Product IDs
pub const GS_USB_PIDS: &[u16] = &[
    0x606f, // Geschwister Schneider USB/CAN, candleLight
    0x606d, // CANable (candleLight firmware)
];

// ============================================================================
// gs_usb Protocol Constants
// ============================================================================

/// gs_usb control request types
#[repr(u8)]
#[derive(Debug, Clone, Copy)]
pub enum GsUsbBreq {
    HostFormat = 0,
    Bittiming = 1,
    Mode = 2,
    Berr = 3,
    BtConst = 4,
    DeviceConfig = 5,
    Timestamp = 6,
    Identify = 7,
    GetUserId = 8,
    SetUserId = 10,
    DataBittiming = 11,
    BtConstExt = 12,
    SetTermination = 13,
    GetTermination = 14,
    GetState = 15,
}

/// CAN mode flags
pub mod can_mode {
    pub const NORMAL: u32 = 0;
    pub const LISTEN_ONLY: u32 = 1 << 0;
    pub const LOOP_BACK: u32 = 1 << 1;
    pub const TRIPLE_SAMPLE: u32 = 1 << 2;
    pub const ONE_SHOT: u32 = 1 << 3;
    pub const HW_TIMESTAMP: u32 = 1 << 4;
    pub const FD: u32 = 1 << 8;
}

/// CAN ID flags (in can_id field)
pub mod can_id_flags {
    pub const EXTENDED: u32 = 0x80000000;
    pub const RTR: u32 = 0x40000000;
    pub const ERR: u32 = 0x20000000;
    pub const ID_MASK: u32 = 0x1FFFFFFF;
}

/// Echo ID indicating received frame (not TX echo)
pub const GS_USB_ECHO_ID_RX: u32 = 0xFFFFFFFF;

/// Host format magic value for byte order negotiation
pub const GS_USB_HOST_FORMAT: u32 = 0x0000beef;

// ============================================================================
// Protocol Structures
// ============================================================================

/// gs_usb host frame structure (20 bytes for classic CAN)
#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct GsHostFrame {
    pub echo_id: u32,
    pub can_id: u32,
    pub can_dlc: u8,
    pub channel: u8,
    pub flags: u8,
    pub reserved: u8,
    pub data: [u8; 8],
}

impl GsHostFrame {
    pub const SIZE: usize = 20;

    /// Check if this is a received frame (not a TX echo)
    pub fn is_rx(&self) -> bool {
        self.echo_id == GS_USB_ECHO_ID_RX
    }

    /// Check if this is an extended ID frame
    pub fn is_extended(&self) -> bool {
        self.can_id & can_id_flags::EXTENDED != 0
    }

    /// Check if this is an RTR frame
    pub fn is_rtr(&self) -> bool {
        self.can_id & can_id_flags::RTR != 0
    }

    /// Get the CAN ID (without flags)
    pub fn get_can_id(&self) -> u32 {
        self.can_id & can_id_flags::ID_MASK
    }

    /// Get data bytes based on DLC
    pub fn get_data(&self) -> &[u8] {
        let len = (self.can_dlc as usize).min(8);
        &self.data[..len]
    }

    /// Safely construct from a byte slice (must be at least 20 bytes).
    /// Returns None if the slice is too short.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < Self::SIZE {
            return None;
        }
        Some(GsHostFrame {
            echo_id: u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
            can_id: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            can_dlc: data[8],
            channel: data[9],
            flags: data[10],
            reserved: data[11],
            data: [
                data[12], data[13], data[14], data[15],
                data[16], data[17], data[18], data[19],
            ],
        })
    }
}

/// Device configuration response
#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct GsDeviceConfig {
    pub reserved1: u8,
    pub reserved2: u8,
    pub reserved3: u8,
    pub icount: u8,      // Number of CAN interfaces
    pub sw_version: u32,
    pub hw_version: u32,
}

impl GsDeviceConfig {
    pub const SIZE: usize = 12;

    /// Safely construct from a byte slice (must be at least 12 bytes).
    /// Returns None if the slice is too short.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < Self::SIZE {
            return None;
        }
        Some(GsDeviceConfig {
            reserved1: data[0],
            reserved2: data[1],
            reserved3: data[2],
            icount: data[3],
            sw_version: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            hw_version: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
        })
    }
}

/// Bit timing constants (device capabilities)
#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct GsDeviceBtConst {
    pub feature: u32,
    pub fclk_can: u32,
    pub tseg1_min: u32,
    pub tseg1_max: u32,
    pub tseg2_min: u32,
    pub tseg2_max: u32,
    pub sjw_max: u32,
    pub brp_min: u32,
    pub brp_max: u32,
    pub brp_inc: u32,
}

impl GsDeviceBtConst {
    pub const SIZE: usize = 40;
}

/// Bit timing configuration
#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct GsDeviceBittiming {
    pub prop_seg: u32,
    pub phase_seg1: u32,
    pub phase_seg2: u32,
    pub sjw: u32,
    pub brp: u32,
}

impl GsDeviceBittiming {
    pub const SIZE: usize = 20;
}

/// Device mode configuration
#[repr(C, packed)]
#[derive(Debug, Clone, Copy)]
pub struct GsDeviceMode {
    pub mode: u32,
    pub flags: u32,
}

impl GsDeviceMode {
    pub const SIZE: usize = 8;
}

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
}

impl Default for GsUsbConfig {
    fn default() -> Self {
        Self {
            bus: 0,
            address: 0,
            serial: None,
            bitrate: 500_000,
            listen_only: true,
            channel: 0,
            limit: None,
            display_name: None,
            bus_override: None,
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
// Bitrate Calculation
// ============================================================================

/// Common CAN bitrates with pre-calculated timing for 48MHz clock
/// (CANable uses STM32F042 with 48MHz clock)
///
/// Formula: bitrate = 48MHz / (brp * (1 + prop_seg + phase_seg1 + phase_seg2))
/// With prop_seg=0, phase_seg1=13, phase_seg2=2: 16 time quanta per bit
/// So: brp = 3_000_000 / bitrate
pub const COMMON_BITRATES: &[(u32, GsDeviceBittiming)] = &[
    (
        10_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 300,
        },
    ),
    (
        20_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 150,
        },
    ),
    (
        50_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 60,
        },
    ),
    (
        100_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 30,
        },
    ),
    (
        125_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 24,
        },
    ),
    (
        250_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 12,
        },
    ),
    (
        500_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 6,
        },
    ),
    (
        750_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 4,
        },
    ),
    (
        1_000_000,
        GsDeviceBittiming {
            prop_seg: 0,
            phase_seg1: 13,
            phase_seg2: 2,
            sjw: 1,
            brp: 3,
        },
    ),
];

/// Get pre-calculated timing for a common bitrate
pub fn get_bittiming_for_bitrate(bitrate: u32) -> Option<GsDeviceBittiming> {
    COMMON_BITRATES
        .iter()
        .find(|(rate, _)| *rate == bitrate)
        .map(|(_, timing)| *timing)
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
#[tauri::command]
pub fn probe_gs_usb_device(bus: u8, address: u8) -> Result<GsUsbProbeResult, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        nusb_driver::probe_device(bus, address).map_err(String::from)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (bus, address);
        Err("Device probing is only available on Windows/macOS. On Linux, use ip link show to check interface status.".to_string())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gs_host_frame_size() {
        assert_eq!(std::mem::size_of::<GsHostFrame>(), GsHostFrame::SIZE);
    }

    #[test]
    fn test_gs_device_config_size() {
        assert_eq!(
            std::mem::size_of::<GsDeviceConfig>(),
            GsDeviceConfig::SIZE
        );
    }

    #[test]
    fn test_frame_id_parsing() {
        let frame = GsHostFrame {
            echo_id: GS_USB_ECHO_ID_RX,
            can_id: 0x80000123, // Extended ID 0x123
            can_dlc: 4,
            channel: 0,
            flags: 0,
            reserved: 0,
            data: [0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0],
        };

        assert!(frame.is_rx());
        assert!(frame.is_extended());
        assert!(!frame.is_rtr());
        assert_eq!(frame.get_can_id(), 0x123);
        assert_eq!(frame.get_data(), &[0x01, 0x02, 0x03, 0x04]);
    }

    #[test]
    fn test_common_bitrates() {
        // All supported bitrates should have timing
        assert!(get_bittiming_for_bitrate(10_000).is_some());
        assert!(get_bittiming_for_bitrate(20_000).is_some());
        assert!(get_bittiming_for_bitrate(50_000).is_some());
        assert!(get_bittiming_for_bitrate(100_000).is_some());
        assert!(get_bittiming_for_bitrate(125_000).is_some());
        assert!(get_bittiming_for_bitrate(250_000).is_some());
        assert!(get_bittiming_for_bitrate(500_000).is_some());
        assert!(get_bittiming_for_bitrate(750_000).is_some());
        assert!(get_bittiming_for_bitrate(1_000_000).is_some());
        // Unsupported bitrate should return None
        assert!(get_bittiming_for_bitrate(123_456).is_none());
    }

    #[test]
    fn test_gs_host_frame_from_bytes() {
        // Valid 20-byte frame
        let data: [u8; 20] = [
            0xFF, 0xFF, 0xFF, 0xFF, // echo_id = 0xFFFFFFFF (RX marker)
            0x23, 0x01, 0x00, 0x80, // can_id = 0x80000123 (extended)
            0x04,                   // can_dlc = 4
            0x00,                   // channel = 0
            0x00,                   // flags = 0
            0x00,                   // reserved = 0
            0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, // data
        ];
        let frame = GsHostFrame::from_bytes(&data).expect("should parse valid frame");
        // Copy packed fields to local variables to avoid unaligned references
        let echo_id = { frame.echo_id };
        let can_dlc = { frame.can_dlc };
        assert_eq!(echo_id, GS_USB_ECHO_ID_RX);
        assert!(frame.is_rx());
        assert!(frame.is_extended());
        assert_eq!(frame.get_can_id(), 0x123);
        assert_eq!(can_dlc, 4);
        assert_eq!(frame.get_data(), &[0x01, 0x02, 0x03, 0x04]);

        // Too short - should return None
        let short_data: [u8; 19] = [0; 19];
        assert!(GsHostFrame::from_bytes(&short_data).is_none());

        // Empty slice - should return None
        assert!(GsHostFrame::from_bytes(&[]).is_none());
    }

    #[test]
    fn test_gs_device_config_from_bytes() {
        // Valid 12-byte config
        let data: [u8; 12] = [
            0x00, 0x00, 0x00, // reserved 1-3
            0x02,             // icount = 2 interfaces
            0x01, 0x02, 0x03, 0x04, // sw_version = 0x04030201
            0x10, 0x20, 0x30, 0x40, // hw_version = 0x40302010
        ];
        let config = GsDeviceConfig::from_bytes(&data).expect("should parse valid config");
        // Copy packed fields to local variables to avoid unaligned references
        let icount = { config.icount };
        let sw_version = { config.sw_version };
        let hw_version = { config.hw_version };
        assert_eq!(icount, 2);
        assert_eq!(sw_version, 0x04030201);
        assert_eq!(hw_version, 0x40302010);

        // Too short - should return None
        let short_data: [u8; 11] = [0; 11];
        assert!(GsDeviceConfig::from_bytes(&short_data).is_none());

        // Empty slice - should return None
        assert!(GsDeviceConfig::from_bytes(&[]).is_none());
    }
}

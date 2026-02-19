// ui/src-tauri/src/io/socketcan/mod.rs
//
// SocketCAN driver for Linux native CAN interfaces.
// Used with CANable Pro (Candlelight firmware) or native CAN hardware.
//
// Requires the interface to be configured first:
//   sudo ip link set can0 up type can bitrate 500000
//
// This module is only fully functional on Linux.

// Allow dead code on non-Linux platforms where this module is not functional
#![allow(dead_code)]

pub mod codec;
mod reader;

// Re-export reader types (platform-specific)
#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub use reader::{encode_frame, run_source, EncodedFrame, SocketCanConfig, SocketCanReader};

#[cfg(not(target_os = "linux"))]
#[allow(unused_imports)]
pub use reader::{encode_frame, run_source, EncodedFrame, SocketCanConfig};

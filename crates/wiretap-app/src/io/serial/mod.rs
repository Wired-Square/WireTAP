// ui/crates/wiretap-app/src/io/serial/mod.rs
//
// Serial port driver with optional framing support.
// Provides cross-platform serial communication for WireTAP.
//
// Features:
// - Raw byte streaming (bytes-ready signal + buffer fetch)
// - Framed message extraction (SLIP, Modbus RTU, delimiter-based)
// - Bidirectional communication (read + transmit)

pub mod reader; // pub for Tauri command access (list_serial_ports)
pub(crate) mod utils;

pub use reader::run_source;

// Re-export profile parsing for multi-source
pub use utils::parse_profile_for_source;

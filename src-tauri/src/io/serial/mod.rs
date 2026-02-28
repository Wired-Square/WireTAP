// ui/src-tauri/src/io/serial/mod.rs
//
// Serial port driver with optional framing support.
// Provides cross-platform serial communication for WireTAP.
//
// Features:
// - Raw byte streaming (serial-raw-bytes events)
// - Framed message extraction (SLIP, Modbus RTU, delimiter-based)
// - Bidirectional communication (read + transmit)

pub mod framer;
pub mod reader; // pub for Tauri command access (list_serial_ports)
pub(crate) mod utils;

// Re-export framer types used by other modules
pub use framer::{extract_frame_id, FrameIdConfig, FramingEncoding, SerialFramer};

// Re-export reader types used by other modules
pub use reader::{run_source, Parity};

// Re-export profile parsing for multi-source
pub use utils::parse_profile_for_source;

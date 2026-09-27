// ui/crates/wiretap-app/src/io/socketcan/mod.rs
//
// SocketCAN driver for Linux native CAN interfaces.
// Used with CANable Pro (Candlelight firmware) or native CAN hardware.
//
// Requires the interface to be configured first:
//   sudo ip link set can0 up type can bitrate 500000

mod reader;

pub use reader::run_source;

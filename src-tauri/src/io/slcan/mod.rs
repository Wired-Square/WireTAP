// ui/src-tauri/src/io/slcan/mod.rs
//
// slcan (Serial Line CAN) protocol driver for CANable, CANable Pro, and other
// USB-CAN adapters using the Lawicel/slcan ASCII protocol.
//
// Protocol reference: http://www.can232.com/docs/can232_v3.pdf

pub mod codec;
pub mod reader; // pub for Tauri command access (probe_slcan_device)

// Re-export public items
// Note: SlcanCodec is also available via io::codec::SlcanCodec
pub use reader::encode_transmit_frame;

// Internal items used by multi_source
pub(crate) use reader::run_source as run_slcan_source;

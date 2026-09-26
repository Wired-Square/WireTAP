// ui/crates/wiretap-app/src/io/slcan/mod.rs
//
// slcan (Serial Line CAN) protocol driver for CANable, CANable Pro, and other
// USB-CAN adapters using the Lawicel/slcan ASCII protocol.
//
// Protocol reference: http://www.can232.com/docs/can232_v3.pdf

pub mod reader; // pub for Tauri command access (probe_slcan_device)

pub(crate) use reader::run_source as run_slcan_source;

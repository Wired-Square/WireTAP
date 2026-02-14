// ui/src-tauri/src/io/gvret/mod.rs
//
// GVRET protocol driver - supports TCP and USB connections to GVRET/SavvyCAN devices.
//
// Protocol reference: https://github.com/collin80/GVRET

pub mod codec;
mod common;
mod tcp;
#[cfg(not(target_os = "ios"))]
mod usb;

// Re-export public items
pub use codec::GvretCodec;
pub use common::{BusMapping, GvretDeviceInfo};
pub use tcp::probe_gvret_tcp;
#[cfg(not(target_os = "ios"))]
pub use usb::probe_gvret_usb;

// Internal items used by multi_source and other drivers
pub(crate) use common::{
    apply_bus_mapping, encode_gvret_frame, validate_gvret_frame,
};
// parse_gvret_frames exported for tests
#[cfg(test)]
pub(crate) use common::parse_gvret_frames;
pub(crate) use tcp::run_source as run_gvret_tcp_source;
#[cfg(not(target_os = "ios"))]
pub(crate) use usb::run_source as run_gvret_usb_source;

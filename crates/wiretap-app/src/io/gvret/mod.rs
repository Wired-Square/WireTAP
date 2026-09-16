// ui/crates/wiretap-app/src/io/gvret/mod.rs
//
// GVRET protocol driver - supports TCP and USB connections to GVRET/SavvyCAN devices.
//
// Protocol reference: https://github.com/collin80/GVRET

mod common;
mod tcp;
#[cfg(not(target_os = "ios"))]
mod usb;

// Re-export public items
pub use common::{GvretDeviceInfo, MAX_BUSES};
pub use tcp::probe_gvret_tcp;
#[cfg(not(target_os = "ios"))]
pub use usb::probe_gvret_usb;

// Internal items used by multi_source and other drivers
pub(crate) use common::validate_gvret_frame;
pub(crate) use tcp::run_source as run_gvret_tcp_source;
#[cfg(not(target_os = "ios"))]
pub(crate) use usb::run_source as run_gvret_usb_source;

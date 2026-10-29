// io/broker/types.rs
//
// Type definitions for IO broker sessions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::io::bus_mapping::BusMapping;
use crate::io::modbus_tcp::PollGroup;
use crate::io::types::{ControlSender, TransmitSender};
use crate::io::Protocol;
pub use crate::io::profile::SerialOverrides;

/// Configuration for a single source in a multi-source session
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SourceConfig {
    /// Profile ID for this source
    pub profile_id: String,
    /// Profile kind (gvret_tcp, gvret_usb, gs_usb, socketcan, slcan, serial, modbus_tcp)
    pub profile_kind: String,
    /// Display name for this source
    pub display_name: String,
    /// Bus mappings for this source (device bus -> output bus)
    pub bus_mappings: Vec<BusMapping>,
    /// Serial settings this session overrides. Flattened, so the wire shape stays
    /// the flat keys the frontend sends.
    #[serde(flatten)]
    pub serial: SerialOverrides,
    /// Modbus poll groups (shared across all Modbus interfaces in a session)
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Array<unknown> | null"))]
    pub modbus_polls: Option<Vec<PollGroup>>,
    /// Modbus max consecutive register errors before stopping (0 = never stop)
    #[serde(default)]
    pub max_register_errors: Option<u32>,
}

impl SourceConfig {
    /// A virtual device's buses all carry its traffic type, so a serial one
    /// generates raw bytes where the others generate frames.
    pub(super) fn is_virtual_serial(&self) -> bool {
        self.profile_kind == "virtual"
            && self.bus_mappings.iter().any(|m| m.protocol == Protocol::Serial)
    }

    pub(super) fn transmits_raw_bytes(&self) -> bool {
        matches!(self.profile_kind.as_str(), "serial" | "framelink") || self.is_virtual_serial()
    }
}

/// Transmit routing info: maps output bus to source and device bus
#[derive(Clone, Debug)]
pub(super) struct TransmitRoute {
    /// Source index in the sources array
    pub source_idx: usize,
    /// Profile ID for logging
    pub profile_id: String,
    /// Profile kind for frame encoding (gvret_tcp, gvret_usb, gs_usb, socketcan, slcan)
    pub profile_kind: String,
    /// Device bus number to use when transmitting
    pub device_bus: u8,
}

/// Whether each source's polling is paused, by profile id. Shared between the
/// broker (which reports it) and the merge task (which creates the flags and
/// hands each source its own).
pub(super) type SourcePauseFlags = Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>;

/// Shared transmit channels by source index
pub(super) type TransmitChannels = Arc<Mutex<HashMap<usize, TransmitSender>>>;

/// Shared control channels by source index (live framing changes; serial only)
pub(super) type ControlChannels = Arc<Mutex<HashMap<usize, ControlSender>>>;

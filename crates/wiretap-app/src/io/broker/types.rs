// io/broker/types.rs
//
// Type definitions for IO broker sessions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::io::bus_mapping::BusMapping;
use crate::io::modbus_tcp::PollGroup;
use crate::io::types::{ControlSender, TransmitSender};

/// The serial settings a session may override on one source, as the picker sends
/// them. Every field is optional: absent means "whatever the device profile says".
///
/// **One declaration, threaded whole.** These were previously spelled out in
/// three structs and exploded into loose parameters twice on the way to
/// the reader, and the settings that got dropped were the ones somebody forgot to
/// add to one of those lists — the picker's framing choice, and then its
/// "capture raw bytes" tick. Add a serial setting here and it reaches the reader
/// on its own.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SerialOverrides {
    /// Framing encoding for serial sources (overrides profile settings if provided)
    pub framing_encoding: Option<String>,
    /// Delimiter bytes for delimiter-based framing
    pub delimiter: Option<Vec<u8>>,
    /// Maximum frame length for delimiter-based framing
    pub max_frame_length: Option<usize>,
    /// Minimum frame length - frames shorter than this are discarded
    pub min_frame_length: Option<usize>,
    /// Whether to emit raw bytes in addition to framed data
    pub emit_raw_bytes: Option<bool>,
    /// Whether to check the CRC-16 on Modbus RTU framing
    pub modbus_validate_crc: Option<bool>,
    /// Modbus RTU slave address to sync on; absent means any valid address
    pub modbus_device_address: Option<u8>,
    /// Function codes the RTU length rules do not model but this line carries
    pub modbus_vendor_functions: Option<Vec<u8>>,
    /// Whether address 0 may start a Modbus RTU message
    pub modbus_allow_broadcast: Option<bool>,
    /// Whether every Modbus function code frames, declared or not
    pub modbus_any_function: Option<bool>,
    /// Frame ID extraction: start byte position (0-indexed)
    pub frame_id_start_byte: Option<i32>,
    /// Frame ID extraction: number of bytes (1 or 2)
    pub frame_id_bytes: Option<u8>,
    /// Frame ID extraction: byte order (true = big endian)
    pub frame_id_big_endian: Option<bool>,
    /// Source address extraction: start byte position (0-indexed)
    pub source_address_start_byte: Option<i32>,
    /// Source address extraction: number of bytes (1 or 2)
    pub source_address_bytes: Option<u8>,
    /// Source address extraction: byte order (true = big endian)
    pub source_address_big_endian: Option<bool>,
}

/// Configuration for a single source in a multi-source session
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
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
    pub modbus_polls: Option<Vec<PollGroup>>,
    /// Modbus max consecutive register errors before stopping (0 = never stop)
    #[serde(default)]
    pub max_register_errors: Option<u32>,
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

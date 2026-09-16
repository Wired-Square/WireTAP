// ui/crates/wiretap-app/src/io/bus_mapping.rs
//
// How a device's buses become a session's buses.
//
// Every multi-bus driver reconciles what a device reports against what a
// profile asked for, and every one of them then renumbers or mutes a frame on
// the way past. That is a session concept, not a protocol one — it lived in the
// GVRET module only because GVRET was the first driver to need it, and once the
// GVRET wire codec moved to `wiretap-protocol` there was nothing left in that
// module for it to be near.

use crate::io::traits::traits_for_protocol;
use crate::io::{FrameMessage, InterfaceTraits, Protocol};

/// Configuration for mapping device buses to output buses
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BusMapping {
    /// Bus number as reported by the device (0-4)
    pub device_bus: u8,
    /// Whether to capture frames from this bus
    pub enabled: bool,
    /// Bus number to use in emitted frames (0-255)
    pub output_bus: u8,
    /// Human-readable interface identifier (e.g., "can0", "serial1")
    #[serde(default)]
    pub interface_id: String,
    /// The protocol this bus carries — the *input*. Set from the profile, and
    /// overridable per session by the source picker's protocol dropdown.
    #[serde(default)]
    pub protocol: Protocol,
    /// What this bus may be set to, for the picker to render. Advisory *output*:
    /// Rust answers it from the profile kind, the frontend never sends it.
    #[serde(default, skip_deserializing)]
    pub supported_protocols: Vec<Protocol>,
    /// Traits for this specific interface. Derived *output* — always
    /// `traits_for_protocol(protocol)`, never what a caller supplied.
    #[serde(default)]
    pub traits: Option<InterfaceTraits>,
}

impl BusMapping {
    /// Set the protocol and re-derive the traits that follow from it. The only
    /// way `protocol` and `traits` are allowed to move, so they cannot drift.
    pub fn with_protocol(mut self, protocol: Protocol) -> Self {
        self.protocol = protocol;
        self.traits = Some(traits_for_protocol(protocol));
        self
    }

    /// This bus's traits.
    ///
    /// Derived at the point of use rather than read out of `traits`, so the
    /// field's promise — always `traits_for_protocol(protocol)` — holds by
    /// construction instead of by every writer remembering. Every producer
    /// already sets exactly this; the only thing the stored value can add is a
    /// blob a caller sent, which is the thing it must not be able to add.
    pub fn effective_traits(&self) -> InterfaceTraits {
        traits_for_protocol(self.protocol)
    }
}

impl Default for BusMapping {
    fn default() -> Self {
        Self {
            device_bus: 0,
            enabled: true,
            output_bus: 0,
            interface_id: "can0".to_string(),
            protocol: Protocol::Can,
            supported_protocols: Vec::new(),
            traits: Some(traits_for_protocol(Protocol::Can)),
        }
    }
}

/// Create default bus mappings for a device with the given bus count.
///
/// Every bus is classic CAN — the same answer a bus configured in Settings gets
/// when its protocol is unset. These two used to disagree, so a GVRET that had
/// been probed but never configured advertised CAN FD while the same device
/// *with* a saved bus list advertised plain CAN. The picker's protocol dropdown
/// is now how a bus is told it carries FD.
pub fn default_bus_mappings(bus_count: u8) -> Vec<BusMapping> {
    (0..bus_count)
        .map(|i| BusMapping {
            device_bus: i,
            enabled: true,
            output_bus: i,
            interface_id: format!("can{}", i),
            supported_protocols: gvret_protocols(),
            ..BusMapping::default().with_protocol(Protocol::Can)
        })
        .collect()
}

/// What a GVRET bus may be set to, from the one per-kind table.
pub(crate) fn gvret_protocols() -> Vec<Protocol> {
    crate::io::traits::supported_protocols_for_kind("gvret_tcp").to_vec()
}

/// Apply bus mappings to a frame, returning None if the bus is disabled
pub fn apply_bus_mapping(frame: &mut FrameMessage, mappings: &[BusMapping]) -> bool {
    // Find mapping for this device bus
    if let Some(mapping) = mappings.iter().find(|m| m.device_bus == frame.bus) {
        if mapping.enabled {
            frame.bus = mapping.output_bus;
            true
        } else {
            false // Bus is disabled, skip frame
        }
    } else {
        // No mapping found, pass through unchanged
        true
    }
}

// ============================================================================
// Frame Batch Helpers
// ============================================================================

/// Apply bus mappings to a batch of frames, dropping the ones whose bus is
/// muted and renumbering the rest onto their output bus.
pub fn apply_bus_mappings_batch(
    frames: Vec<FrameMessage>,
    mappings: &[BusMapping],
) -> Vec<FrameMessage> {
    frames
        .into_iter()
        .filter_map(|mut frame| apply_bus_mapping(&mut frame, mappings).then_some(frame))
        .collect()
}

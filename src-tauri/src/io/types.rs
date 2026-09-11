// ui/src-tauri/src/io/source_types.rs
//
// Shared types for multi-source streaming.
// Used by interface implementations to communicate with the merge task.

use std::sync::mpsc as std_mpsc;

use super::FrameMessage;

// ============================================================================
// Source Messages
// ============================================================================

/// Timestamped byte entry for raw byte streams (serial, SPI, etc.)
#[derive(Clone, Debug)]
pub struct ByteEntry {
    pub byte: u8,
    pub timestamp_us: u64,
    /// Bus/interface number (from bus mapping)
    pub bus: u8,
}

/// Why a source's read loop finished.
///
/// The rule is *`Ended` = we asked, `Error` = we didn't*, and it used to be a
/// convention over a free-text reason: every producer sent `Ended`, the merge
/// task counted it down, and a GVRET adapter pulled out of its socket mid-session
/// finished the run as `"complete"`. Making the reason a type means a new driver
/// has to say which of the two happened, and the answer is checked rather than
/// spelled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    /// The stop flag was set — the user, or the session, asked for this.
    Stopped,
    /// The peer closed or the device went away without being asked to.
    Disconnected,
}

impl EndReason {
    /// True when nobody asked for this ending, so the session must report an error.
    pub fn is_fault(self) -> bool {
        matches!(self, EndReason::Disconnected)
    }
}

impl std::fmt::Display for EndReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            EndReason::Stopped => "stopped",
            EndReason::Disconnected => "disconnected",
        })
    }
}

/// Internal message from sub-readers to the merge task
pub enum SourceMessage {
    /// Frames from a source (source_index, frames)
    Frames(usize, Vec<FrameMessage>),
    /// Raw bytes from a source (source_index, bytes with timestamps)
    /// Only constructed by serial reader which is not available on iOS
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    Bytes(usize, Vec<ByteEntry>),
    /// Source ended (source_index, reason)
    Ended(usize, EndReason),
    /// Source error (source_index, error)
    Error(usize, String),
    /// Transmit channel is ready (source_index, transmit_sender)
    TransmitReady(usize, TransmitSender),
    /// Control channel is ready (source_index, control_sender) — serial only,
    /// for live framing changes.
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    ControlReady(usize, ControlSender),
    /// Source connected successfully (source_index, device_type, address, bus_number)
    Connected(usize, String, String, Option<u8>),
    /// A source has reconciled its bus mappings against the connected device
    /// (source_index, mappings).
    ///
    /// The mappings a session starts with are built from the profile before any
    /// connection exists, so they can be wrong in both directions: a bus the
    /// device does not have, or — the expensive one — a bus it does have that
    /// nothing is listening to. A driver that can enumerate its interfaces sends
    /// this once connected; the broker adopts it for `available_buses` and
    /// transmit routing so receive and transmit agree on the same set.
    MappingsResolved(usize, Vec<crate::io::bus_mapping::BusMapping>),
}

// ============================================================================
// Transmit Types
// ============================================================================

/// Transmit request sent through the channel
pub struct TransmitRequest {
    /// Encoded frame bytes ready to send
    pub data: Vec<u8>,
    /// Sync oneshot channel to send the result back
    pub result_tx: std_mpsc::SyncSender<Result<(), String>>,
}

/// Sender type for transmit requests (sync-safe)
pub type TransmitSender = std_mpsc::SyncSender<TransmitRequest>;

// ============================================================================
// Control Types (live framing changes)
// ============================================================================

/// Everything a `ModbusRtuStream` needs, in one place.
///
/// Threaded whole for the reason [`crate::io::SerialOverrides`] gives: these were
/// four loose values built at five sites, three of which had quietly settled on
/// `device_address: None`. It lives here rather than beside the serial framer
/// because the CAN tunnel wants it too, and because `SetFramingRequest` below
/// must stay buildable on a platform with no serial port.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ModbusRtuOptions {
    /// Device address filter (1-247). `None` syncs on any valid address.
    pub device_address: Option<u8>,
    /// Whether a message has to pass its CRC to be framed. `false` is a lenient
    /// mode, not "no framing" — see `CrcPolicy::Lenient`.
    pub validate_crc: bool,
    /// Function codes the RTU length rules do not model but this line carries.
    /// Framed by CRC search instead; empty leaves stock Modbus untouched.
    pub vendor_functions: Vec<u8>,
    /// Whether address 0 may start a message, for a master that broadcasts.
    pub allow_broadcast: bool,
    /// Frame every function code, declared or not. What a tap on an unknown
    /// line wants, at the cost of a fabricated message about once in 260
    /// resyncs — see `ModbusRtuStream::frame_any_function`.
    pub any_function: bool,
}

/// Stock Modbus: CRC enforced, no vendor codes, no broadcast. Guessing at any of
/// the three is how a framer invents messages out of noise.
impl Default for ModbusRtuOptions {
    fn default() -> Self {
        Self {
            device_address: None,
            validate_crc: true,
            vendor_functions: Vec::new(),
            allow_broadcast: false,
            any_function: false,
        }
    }
}

impl ModbusRtuOptions {
    /// A stream configured for this line. Both opt-ins union with whatever a
    /// catalogue declares, which is the crate's contract for them.
    pub fn stream(&self) -> wiretap_catalog::ModbusRtuStream {
        let policy = if self.validate_crc {
            wiretap_catalog::CrcPolicy::Strict
        } else {
            wiretap_catalog::CrcPolicy::Lenient
        };
        let mut stream =
            wiretap_catalog::ModbusRtuStream::with_crc_policy(self.device_address, policy)
                .with_vendor_functions(&self.vendor_functions);
        if self.allow_broadcast {
            stream = stream.allow_broadcast();
        }
        if self.any_function {
            stream = stream.frame_any_function();
        }
        stream
    }
}

/// A live framing change for a running serial source. Carries primitives only
/// (no serial-only types) so the shared broker can hold/dispatch it on every
/// platform; the serial reader rebuilds the `FramingEncoding`/`FrameIdConfig`.
#[derive(Clone, Debug)]
pub struct SetFramingRequest {
    /// `slip` | `modbus_rtu` | `delimiter` | `raw` | … (anything not a real
    /// framer resolves to raw, matching `parse_profile_for_source`).
    pub encoding: String,
    pub frame_id_start_byte: Option<i32>,
    pub frame_id_bytes: Option<u8>,
    pub frame_id_big_endian: bool,
    pub source_address_start_byte: Option<i32>,
    pub source_address_bytes: Option<u8>,
    pub source_address_big_endian: bool,
    pub min_frame_length: usize,
    pub emit_raw_bytes: bool,
    /// Modbus RTU settings, when `encoding` names that framer. `None` keeps the
    /// stock defaults.
    pub modbus: Option<ModbusRtuOptions>,
}

/// Sender type for control requests (sync-safe), mirroring `TransmitSender`.
pub type ControlSender = std_mpsc::SyncSender<SetFramingRequest>;

#[cfg(test)]
mod tests {
    use super::*;

    fn rtu(body: &str) -> Vec<u8> {
        let mut out: Vec<u8> = (0..body.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&body[i..i + 2], 16).unwrap())
            .collect();
        out.extend(wiretap_checksum::algorithms::crc16_modbus_checksum(&out).to_le_bytes());
        out
    }

    /// `any_function` is what lets an undeclared code frame; the codes the RTU
    /// length rules model must still come out at their spec lengths under it,
    /// not at whatever boundary a CRC search finds first.
    #[test]
    fn any_function_frames_the_undeclared_and_keeps_the_length_rules() {
        let request = rtu("01044DE20002");
        let response = rtu("010404CAFEF00D");
        let vendor = rtu("0165030000010001");
        let line: Vec<u8> = [&request[..], &response[..], &vendor[..]].concat();

        let stock: Vec<Vec<u8>> = ModbusRtuOptions::default()
            .stream()
            .push_bytes(&line)
            .into_iter()
            .map(|m| m.raw)
            .collect();
        assert_eq!(stock, vec![request.clone(), response.clone()]);

        let any: Vec<Vec<u8>> = ModbusRtuOptions { any_function: true, ..Default::default() }
            .stream()
            .push_bytes(&line)
            .into_iter()
            .map(|m| m.raw)
            .collect();
        assert_eq!(any, vec![request, response, vendor]);
    }

    /// The whole point of the type: exactly one ending is a fault, and the merge
    /// task raises a session error for it. A device pulled mid-session used to
    /// finish the run as "complete" because every producer sent the same `Ended`.
    #[test]
    fn only_an_unasked_for_ending_is_a_fault() {
        assert!(EndReason::Disconnected.is_fault());
        assert!(!EndReason::Stopped.is_fault());
    }

    /// The log lines these replaced were free text; keeping the same words means
    /// an existing log filter still matches.
    #[test]
    fn the_reason_prints_the_word_it_replaced() {
        assert_eq!(EndReason::Stopped.to_string(), "stopped");
        assert_eq!(EndReason::Disconnected.to_string(), "disconnected");
    }
}


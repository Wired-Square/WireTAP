// ui/crates/wiretap-app/src/io/source_types.rs
//
// Shared types for multi-source streaming.
// Used by interface implementations to communicate with the merge task.

use std::sync::mpsc as std_mpsc;

use super::{FrameMessage, TransmitResult};

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
    /// The source lost its device and is waiting for it to return: reported
    /// like an error, but the source lives on and its next `Connected` resumes.
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    Interrupted(usize, String),
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
    /// A bus's whole state on the session's bus, and the sends a transmit
    /// timeout lost (source_index, status, tx_dropped).
    #[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
    BusState(usize, crate::io::bus_status::BusStatus, u32),
}

// ============================================================================
// Transmit Types
// ============================================================================

/// Transmit request sent through the channel
pub struct TransmitRequest {
    /// Encoded frame bytes ready to send
    pub data: Vec<u8>,
    /// Set in place of `data` for a source whose device library encodes the frame.
    pub frame: Option<wiretap_io::can::CanFrame>,
    /// Sync oneshot channel to send the result back
    pub result_tx: std_mpsc::SyncSender<Result<(), String>>,
    /// Wait for room in the device's send queue instead of being refused by a full one.
    pub wait_for_room: bool,
}

/// Sender type for transmit requests (sync-safe)
pub type TransmitSender = std_mpsc::SyncSender<TransmitRequest>;

/// A full channel holds 32 frames, which take longer than this to drain at any bit rate.
const ROOM_POLL: std::time::Duration = std::time::Duration::from_millis(1);

/// A transmit routed and encoded for its source, not yet queued.
pub struct PendingTransmit {
    pub tx: TransmitSender,
    pub data: Vec<u8>,
    pub frame: Option<wiretap_io::can::CanFrame>,
}

impl PendingTransmit {
    fn request(self, wait_for_room: bool) -> (TransmitSender, TransmitRequest, Option<Answer>) {
        let (result_tx, result_rx) = std_mpsc::sync_channel(1);
        // A CAN writer answers before the write, so its refusal (a length, FD,
        // RTR or bus the device lacks) is worth waiting for.
        let answer = self.frame.is_some().then_some(result_rx);
        let request = TransmitRequest {
            data: self.data,
            frame: self.frame,
            result_tx,
            wait_for_room,
        };
        (self.tx, request, answer)
    }

    /// Refused at once by a full channel or device queue.
    pub fn send_now(self) -> Result<TransmitResult, String> {
        let (tx, request, answer) = self.request(false);
        tx.try_send(request)
            .map_err(|e| format!("Transmit buffer full ({})", e))?;
        Ok(refused_or_queued(answer.and_then(|answer| answer.recv().ok())))
    }

    /// Waits for room in the channel and the device queue; dropped before it is
    /// queued, nothing is sent.
    pub async fn send_when_ready(self) -> Result<TransmitResult, String> {
        let (tx, mut request, answer) = self.request(true);
        while let Err(e) = tx.try_send(request) {
            let std_mpsc::TrySendError::Full(unsent) = e else {
                return Err(format!("Transmit buffer full ({})", e));
            };
            request = unsent;
            tokio::time::sleep(ROOM_POLL).await;
        }
        let answer = match answer {
            Some(answer) => tokio::task::spawn_blocking(move || answer.recv().ok())
                .await
                .ok()
                .flatten(),
            None => None,
        };
        Ok(refused_or_queued(answer))
    }
}

type Answer = std_mpsc::Receiver<Result<(), String>>;

fn refused_or_queued(answer: Option<Result<(), String>>) -> TransmitResult {
    match answer {
        Some(Err(refused)) => TransmitResult::error(refused),
        _ => TransmitResult::queued(),
    }
}

// ============================================================================
// Control Types (live framing changes)
// ============================================================================

/// How a serial byte stream is cut into frames, in every path that frames one:
/// the port, a live framing change and re-framing a capture. `Raw` is no
/// framing, the bytes as read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum FramingMode {
    #[default]
    Raw,
    Slip,
    Delimiter,
    ModbusRtu,
}

impl std::fmt::Display for FramingMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = serde_json::to_value(self).ok();
        f.write_str(name.as_ref().and_then(serde_json::Value::as_str).unwrap_or_default())
    }
}

#[cfg(test)]
impl FramingMode {
    pub(crate) fn named(name: &str) -> Self {
        serde_json::from_value(serde_json::json!(name)).unwrap()
    }
}

/// Everything a `ModbusRtuStream` needs, in one place.
///
/// Threaded whole for the reason [`crate::io::SerialOverrides`] gives: these were
/// four loose values built at five sites, three of which had quietly settled on
/// `device_address: None`. It lives here rather than beside the serial framer
/// because the CAN tunnel wants it too, and because `SetFramingRequest` below
/// must stay buildable on a platform with no serial port.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(default)]
pub struct ModbusRtuOptions {
    /// Device address filter (1-247). `None` syncs on any valid address.
    #[cfg_attr(test, ts(optional))]
    pub device_address: Option<u8>,
    /// Whether a message has to pass its CRC to be framed. `false` is a lenient
    /// mode, not "no framing" — see `CrcPolicy::Lenient`.
    #[cfg_attr(test, ts(optional = nullable))]
    pub validate_crc: bool,
    /// Function codes the RTU length rules do not model but this line carries.
    /// Framed by CRC search instead; empty leaves stock Modbus untouched.
    #[cfg_attr(test, ts(optional = nullable))]
    pub vendor_functions: Vec<u8>,
    /// Whether address 0 may start a message, for a master that broadcasts.
    #[cfg_attr(test, ts(optional = nullable))]
    pub allow_broadcast: bool,
    /// Frame every function code, declared or not. What a tap on an unknown
    /// line wants, at the cost of a fabricated message about once in 260
    /// resyncs — see `ModbusRtuStream::frame_any_function`.
    #[cfg_attr(test, ts(optional = nullable))]
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
    /// A line somebody else already framed — an archive's whole messages. Every
    /// code and address interprets, since refusing one here would only drop a
    /// message the tap had already judged.
    pub fn tapped() -> Self {
        Self { any_function: true, allow_broadcast: true, ..Default::default() }
    }

    /// A stream configured for this line. Both opt-ins union with whatever a
    /// catalogue declares, which is the crate's contract for them.
    pub fn stream(&self) -> wiretap_catalog::ModbusRtuStream {
        self.with_catalog(None).stream()
    }

    /// The line's options: what `catalog` declares, with these settings on top.
    pub fn with_catalog(
        &self,
        catalog: Option<&wiretap_catalog::Catalog>,
    ) -> wiretap_catalog::ModbusRtuOptions {
        let crc = if self.validate_crc {
            wiretap_catalog::CrcPolicy::Strict
        } else {
            wiretap_catalog::CrcPolicy::Lenient
        };
        let mut rtu = catalog
            .map(wiretap_catalog::Catalog::rtu_options)
            .unwrap_or_default()
            .with_vendor_functions(&self.vendor_functions)
            .with_device_address(self.device_address)
            .with_crc_policy(crc);
        rtu.allow_broadcast |= self.allow_broadcast;
        rtu.any_function |= self.any_function;
        rtu
    }
}

/// A live framing change for a running serial source. Carries primitives only
/// (no serial-only types) so the shared broker can hold/dispatch it on every
/// platform; the serial reader rebuilds the `FramingEncoding`/`FrameIdConfig`.
#[derive(Clone, Debug)]
pub struct SetFramingRequest {
    pub encoding: FramingMode,
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

    #[test]
    fn the_catalogues_codes_and_rules_union_under_the_pickers_settings() {
        use wiretap_catalog::{Catalog, CrcPolicy, VendorLen, VendorLength};
        let catalog = Catalog::parse(
            r#"
[meta]
name = "line"
[meta.modbus.function_code.0x60]
lengths = [{ len = { count_at = 6, overhead = 9 } }]
[meta.modbus.function_code.0x65]
"#,
        )
        .unwrap();
        let picker = ModbusRtuOptions {
            device_address: Some(3),
            validate_crc: false,
            vendor_functions: vec![0x20],
            allow_broadcast: true,
            any_function: false,
        };
        let dispatch = VendorLength {
            function: 0x60,
            when: None,
            len: VendorLen::Counted {
                count_at: 6,
                overhead: 9,
            },
        };
        let manual = wiretap_catalog::ModbusRtuOptions::default()
            .with_device_address(Some(3))
            .with_crc_policy(CrcPolicy::Lenient)
            .allow_broadcast();

        assert_eq!(
            picker.with_catalog(Some(&catalog)),
            manual
                .clone()
                .with_vendor_functions(&[0x60, 0x65, 0x20])
                .with_vendor_lengths(&[dispatch])
        );
        assert_eq!(
            picker.with_catalog(None),
            manual.with_vendor_functions(&[0x20])
        );
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


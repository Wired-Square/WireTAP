// ui/crates/wiretap-app/src/io/source_types.rs
//
// Shared types for multi-source streaming.
// Used by interface implementations to communicate with the merge task.

use std::sync::mpsc as std_mpsc;

use tokio::sync::mpsc::{self, error::TrySendError};
use tokio_util::sync::CancellationToken;

use wslib_wiretap_catalogue::FramingMode;

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
    Error(usize, crate::io::IoFailure),
    /// The source lost its device and is waiting for it to return: reported
    /// like an error, but the source lives on and its next `Connected` resumes.
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    Interrupted(usize, crate::io::IoFailure),
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
    pub frame: Option<wslib_can::CanFrame>,
    /// Sync oneshot channel to send the result back
    pub result_tx: std_mpsc::SyncSender<Result<(), String>>,
    /// Wait for room in the device's send queue instead of being refused by a full one.
    pub wait_for_room: bool,
}

pub type TransmitSender = mpsc::Sender<TransmitRequest>;
pub type TransmitReceiver = mpsc::Receiver<TransmitRequest>;

/// A source's transmit channel, which holds 32 requests.
pub fn transmit_channel() -> (TransmitSender, TransmitReceiver) {
    mpsc::channel(32)
}

/// The next request, queued ones first, or `None` once the channel closes or
/// `until` is cancelled.
pub async fn next_request(
    requests: &mut TransmitReceiver,
    until: &CancellationToken,
) -> Option<TransmitRequest> {
    tokio::select! {
        biased;
        req = requests.recv() => req,
        () = until.cancelled() => None,
    }
}

/// Worded as the std channel this replaced, whose words the transmit history holds.
pub(crate) fn channel_refusal<T>(e: &TrySendError<T>) -> &'static str {
    match e {
        TrySendError::Full(_) => "sending on a full channel",
        TrySendError::Closed(_) => "sending on a closed channel",
    }
}

/// A transmit routed and encoded for its source, not yet queued.
pub struct PendingTransmit {
    pub tx: TransmitSender,
    pub data: Vec<u8>,
    pub frame: Option<wslib_can::CanFrame>,
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
            .map_err(|e| format!("Transmit buffer full ({})", channel_refusal(&e)))?;
        Ok(refused_or_queued(answer.and_then(|answer| answer.recv().ok())))
    }

    /// Waits for room in the channel and the device queue; dropped before it is
    /// queued, nothing is sent.
    pub async fn send_when_ready(self) -> Result<TransmitResult, String> {
        let (tx, request, answer) = self.request(true);
        if tx.send(request).await.is_err() {
            return Err("Transmit buffer full (sending on a closed channel)".to_string());
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

#[cfg(test)]
pub(crate) fn framing_named(name: &str) -> FramingMode {
    serde_json::from_value(serde_json::json!(name)).unwrap()
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
    pub modbus: Option<wslib_wiretap_catalogue::RtuSettings>,
}

/// Sender type for control requests (sync-safe).
pub type ControlSender = std_mpsc::SyncSender<SetFramingRequest>;

#[cfg(test)]
mod tests {
    use super::*;

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


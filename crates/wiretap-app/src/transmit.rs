// ui/crates/wiretap-app/src/transmit.rs
//
// Tauri commands for CAN frame and serial byte transmission.
//
// Transmission works through existing IO sessions (created by Discovery/Decoder or Transmit app).
// This approach avoids creating duplicate connections and integrates with the session model.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::io::{self, CanTransmitFrame, IOCapabilities, TransmitResult};
use crate::settings::{load_settings, IOProfile};

// ============================================================================
// Types
// ============================================================================

/// Writer capabilities - what a transmit-capable profile supports
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WriterCapabilities {
    pub can_transmit_can: bool,
    pub can_transmit_serial: bool,
}

/// Profile info with transmit capabilities
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TransmitProfile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub capabilities: WriterCapabilities,
}

/// How serial bytes are framed on the wire.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SerialFraming {
    #[default]
    Raw,
    Slip,
    Delimiter { delimiter: Vec<u8> },
}

impl SerialFraming {
    pub(crate) fn frame(&self, payload: &[u8]) -> Vec<u8> {
        match self {
            Self::Raw => payload.to_vec(),
            Self::Slip => wiretap_protocol::slip::encode(payload),
            Self::Delimiter { delimiter } => [payload, delimiter].concat(),
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

fn writer_capabilities(profile: &IOProfile) -> WriterCapabilities {
    let traits = io::traits::profile_traits(profile);
    let unblocked = traits.tx_blocked.is_none();
    WriterCapabilities {
        can_transmit_can: unblocked && traits.session.tx_frames,
        can_transmit_serial: unblocked && traits.session.tx_bytes,
    }
}

// ============================================================================
// Tauri Commands - Profile Query
// ============================================================================

/// Get all IO profiles that support transmission
#[tauri::command]
pub async fn get_transmit_capable_profiles(app: AppHandle) -> Result<Vec<TransmitProfile>, String> {
    let settings = load_settings(app).await?;

    let mut profiles = Vec::new();

    for profile in &settings.io_profiles {
        if !crate::io::device_kinds::spec(&profile.kind).is_some_and(|s| s.available) {
            continue;
        }
        let capabilities = writer_capabilities(profile);
        if capabilities.can_transmit_can || capabilities.can_transmit_serial {
            profiles.push(TransmitProfile {
                id: profile.id.clone(),
                name: profile.name.clone(),
                kind: profile.kind.clone(),
                capabilities,
            });
        }
    }

    Ok(profiles)
}

// ============================================================================
// IO Session-Based Transmit Commands
// ============================================================================
//
// These commands transmit through existing IO sessions, avoiding the need
// for separate writer connections. The IO session must be started first.

/// Transmit a CAN frame through an existing IO session
#[tauri::command]
pub async fn io_transmit_can_frame(
    session_id: String,
    frame: CanTransmitFrame,
) -> Result<TransmitResult, String> {
    transmit_can(&session_id, &frame).await
}

/// One CAN transmit, recorded in the history, for the UI and the MCP agent alike.
pub async fn transmit_can(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    let result = send_and_record(session_id, &Outgoing::Can(frame.clone())).await;
    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
    result
}

/// Transmit serial bytes through an IO session, framed as `framing` says
#[tauri::command]
pub async fn io_transmit_serial(
    session_id: String,
    bytes: Vec<u8>,
    framing: SerialFraming,
) -> Result<TransmitResult, String> {
    let result = send_and_record(&session_id, &Outgoing::Serial(framing.frame(&bytes))).await;
    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
    result
}

/// Get IO session capabilities (includes transmit capabilities)
#[tauri::command]
pub async fn get_io_session_capabilities(session_id: String) -> Result<Option<IOCapabilities>, String> {
    Ok(io::get_session_capabilities(&session_id).await)
}

/// Change serial framing on a running session in place (no device reconnect).
/// Used by the Decoder when a serial catalogue is selected mid-stream so the
/// source starts SLIP-framing without a re-watch. Returns the updated capabilities.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn io_set_framing(
    session_id: String,
    encoding: crate::io::FramingMode,
    frame_id_start_byte: Option<i32>,
    frame_id_bytes: Option<u8>,
    frame_id_big_endian: Option<bool>,
    source_address_start_byte: Option<i32>,
    source_address_bytes: Option<u8>,
    source_address_big_endian: Option<bool>,
    min_frame_length: Option<usize>,
    modbus: Option<crate::io::ModbusRtuOptions>,
) -> Result<IOCapabilities, String> {
    let req = crate::io::types::SetFramingRequest {
        encoding,
        modbus,
        frame_id_start_byte,
        frame_id_bytes,
        frame_id_big_endian: frame_id_big_endian.unwrap_or(true),
        source_address_start_byte,
        source_address_bytes,
        source_address_big_endian: source_address_big_endian.unwrap_or(true),
        min_frame_length: min_frame_length.unwrap_or(0),
        // Keep raw bytes flowing (matches mergeSerialConfigForWatch).
        emit_raw_bytes: true,
    };
    io::set_framing(&session_id, req).await
}

/// What one send puts on the wire; serial bytes are already framed.
#[derive(Clone, Debug)]
pub(crate) enum Outgoing {
    Can(CanTransmitFrame),
    Serial(Vec<u8>),
}

/// One send, recorded in the transmit history.
pub(crate) async fn send_and_record(session_id: &str, out: &Outgoing) -> Result<TransmitResult, String> {
    match out {
        Outgoing::Can(frame) => {
            let result = io::transmit_frame(session_id, frame).await;
            record_can(session_id, frame, &result);
            result
        }
        Outgoing::Serial(bytes) => {
            let result = io::transmit_serial(session_id, bytes).await;
            let (success, error) = outcome(&result);
            crate::transmit_history::write_entry(session_id, "serial", None, None, bytes, 0, false, false, success, error);
            result
        }
    }
}

pub(crate) fn record_can(session_id: &str, frame: &CanTransmitFrame, result: &Result<TransmitResult, String>) {
    let (success, error) = outcome(result);
    crate::transmit_history::write_entry(
        session_id,
        "can",
        Some(frame.frame_id as i64),
        Some(frame.data.len() as i64),
        &frame.data,
        frame.bus as i64,
        frame.is_extended,
        frame.is_fd,
        success,
        error,
    );
}

fn outcome(result: &Result<TransmitResult, String>) -> (bool, Option<&str>) {
    match result {
        Ok(r) => (r.success, r.error.as_deref()),
        Err(e) => (false, Some(e)),
    }
}

/// Why a send failed for good, ending the repeat or replay it belongs to; `None`
/// when it went out or the failure may pass.
pub(crate) async fn permanent_failure(session_id: &str, result: &Result<TransmitResult, String>) -> Option<String> {
    let permanent = match result {
        Ok(r) => !r.success && r.error.as_deref().is_some_and(is_permanent_error),
        Err(e) => transmit_refusal_is_permanent(session_id, e).await,
    };
    permanent.then(|| outcome(result).1.unwrap_or("Permanent error").to_string())
}

/// Whether a refused transmit ends a repeat or replay: the session is gone, or
/// the device is.
pub(crate) async fn transmit_refusal_is_permanent(session_id: &str, error: &str) -> bool {
    !io::session_exists(session_id).await || is_permanent_error(error)
}

/// Check if a device error is permanent (should stop repeat) vs transient (can continue)
pub(crate) fn is_permanent_error(error: &str) -> bool {
    let error_lower = error.to_lowercase();
    error_lower.contains("disconnected")
        || error_lower.contains("does not support")
        || error_lower.contains("no device")
        || error_lower.contains("permission denied")
        || error_lower.contains("access denied")
        // Windows renders ERROR_ACCESS_DENIED as "Access is denied." — the "is"
        // means the "access denied" needle above never matches it.
        || error_lower.contains("access is denied")
}

#[cfg(test)]
mod tests {
    use super::{is_permanent_error, SerialFraming};

    fn framing(json: &str) -> SerialFraming {
        serde_json::from_str(json).expect("the framing the Transmit app sends")
    }

    #[test]
    fn raw_serial_goes_out_as_given() {
        assert_eq!(framing(r#"{"mode":"raw"}"#).frame(&[0xC0, 1]), [0xC0, 1]);
    }

    #[test]
    fn slip_wraps_in_end_bytes_and_escapes_them_inside() {
        let slip = framing(r#"{"mode":"slip"}"#);
        assert_eq!(
            slip.frame(&[1, 0xC0, 0xDB, 2]),
            [0xC0, 1, 0xDB, 0xDC, 0xDB, 0xDD, 2, 0xC0]
        );
    }

    #[test]
    fn a_delimiter_is_appended_once() {
        let crlf = framing(r#"{"mode":"delimiter","delimiter":[13,10]}"#);
        assert_eq!(crlf.frame(&[0x41, 0x0D]), [0x41, 0x0D, 0x0D, 0x0A]);
    }

    #[test]
    fn windows_access_denied_is_permanent() {
        // The exact string serialport surfaces on Windows ERROR_ACCESS_DENIED.
        assert!(is_permanent_error("Read error: Access is denied. (os error 5)"));
        assert!(is_permanent_error("Failed to open COM5: Access is denied."));
    }

    #[test]
    fn existing_permanent_needles_still_match() {
        assert!(is_permanent_error("Serial port disconnected"));
        assert!(is_permanent_error("Permission denied"));
    }

    #[test]
    fn transient_error_is_not_permanent() {
        assert!(!is_permanent_error("timed out"));
        assert!(!is_permanent_error("bus off"));
    }

    #[test]
    fn a_refusal_from_a_missing_session_is_permanent_whatever_it_says() {
        assert!(tauri::async_runtime::block_on(super::transmit_refusal_is_permanent("f_gone", "queue full")));
    }

    #[test]
    fn every_kind_whose_bus_transmits_is_offered_to_transmit() {
        for kind in crate::io::device_kinds::kinds() {
            let spec = crate::io::device_kinds::spec(kind).unwrap();
            let profile = crate::settings::IOProfile {
                kind: kind.to_string(),
                connection: serde_json::from_value(serde_json::json!({ "silent_mode": false, "listen_only": false })).unwrap(),
                ..Default::default()
            };
            let offered = super::writer_capabilities(&profile).can_transmit_can;
            assert_eq!(offered, spec.can_tx, "{kind}");
        }
    }

    #[test]
    fn a_listen_only_profile_is_not_offered_to_transmit() {
        for kind in ["slcan", "gs_usb"] {
            let profile = crate::settings::IOProfile { kind: kind.to_string(), ..Default::default() };
            assert!(!super::writer_capabilities(&profile).can_transmit_can, "{kind}");
        }
    }

    #[tokio::test]
    async fn a_transmit_refused_by_a_full_channel_is_recorded_as_failed() {
        crate::transmit_history::use_in_memory_database();
        let id = "f_channel_full";
        let source = crate::io::test_source::TestSource::new(id)
            .refusing("Transmit buffer full (sending on a full channel)");
        crate::io::create_session(id.into(), Box::new(source), None, None, None, vec![]).await;
        let frame = crate::io::CanTransmitFrame { frame_id: 0x100, data: vec![1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false };

        let refused = super::transmit_can(id, &frame).await.unwrap_err();

        let rows = crate::transmit_history::transmit_history_query(id.into(), 0, 10).unwrap();
        assert_eq!(rows.len(), 1, "the refusal never reached the history");
        assert!(!rows[0].success);
        assert_eq!(rows[0].error_msg.as_deref(), Some(refused.as_str()));
        crate::io::destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_serial_send_reaches_history() {
        crate::transmit_history::use_in_memory_database();
        let id = "b_serial_channel_full";
        let source = crate::io::test_source::TestSource::new(id).refusing("Serial transmit buffer full");
        crate::io::create_session(id.into(), Box::new(source), None, None, None, vec![]).await;

        let refused = super::io_transmit_serial(id.into(), vec![0x41], super::SerialFraming::Raw).await.unwrap_err();

        let rows = crate::transmit_history::transmit_history_query(id.into(), 0, 10).unwrap();
        assert_eq!(rows.len(), 1, "the refusal never reached the history");
        assert!(!rows[0].success);
        assert_eq!(rows[0].error_msg.as_deref(), Some(refused.as_str()));
        crate::io::destroy_session(id, false).await.unwrap();
    }
}

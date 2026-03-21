// io/framelink/mod.rs
//
// FrameLink protocol driver for WiredFlexLink devices.
// Connects via TCP, streams CAN and RS-485 frames.

pub mod reader;
pub mod rules;
mod shared;

use std::collections::HashMap;

use framelink::protocol::dsig;
use framelink::protocol::stream::{build_frame_tx, FrameMetadata, StreamFrame};
use framelink::protocol::types::{
    FLAG_ACK_REQ, IFACE_CANFD, MSG_CAPABILITIES_REQ, MSG_DSIG_LIST, MSG_DSIG_READ,
    MSG_DSIG_WRITE, MSG_PERSIST_SAVE,
};
use serde::Serialize;

use super::gvret::BusMapping;
use super::{now_us, FrameMessage};
use crate::io::CanTransmitFrame;

#[derive(Debug, Clone, Serialize)]
pub struct ProbeInterface {
    pub index: u8,
    pub iface_type: u8,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameLinkProbeResult {
    pub device_id: Option<String>,
    pub board_name: Option<String>,
    pub board_revision: Option<String>,
    pub interfaces: Vec<ProbeInterface>,
}

/// Probe a FrameLink device to discover its capabilities.
/// Returns cached data if a managed connection already exists (device accepts only 1 client).
/// Otherwise triggers a connection via the manager, which populates the probe cache.
pub async fn probe_framelink(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<FrameLinkProbeResult, String> {
    if let Some(cached) = shared::get_cached_probe(host, port).await {
        tlog!(
            "[probe_framelink] Returning cached probe data for {}:{}",
            host,
            port
        );
        return Ok(cached);
    }

    tlog!(
        "[probe_framelink] Probing FrameLink device at {}:{} (timeout: {}s)",
        host, port, timeout_sec
    );

    // Trigger connection creation via a capabilities request
    shared::request(host, port, MSG_CAPABILITIES_REQ, FLAG_ACK_REQ, &[], timeout_sec).await?;

    // Connection now exists with populated probe_cache
    shared::get_cached_probe(host, port)
        .await
        .ok_or_else(|| "Connection closed before probe data could be retrieved".to_string())
}

/// Convert a FrameLink StreamFrame to a WireTAP FrameMessage.
pub fn convert_stream_frame(
    sf: &StreamFrame,
    bus_mappings: &[BusMapping],
    iface_types: &std::collections::HashMap<u8, u8>,
) -> Option<FrameMessage> {
    let iface_type = iface_types.get(&sf.iface_index).copied().unwrap_or(0);

    match &sf.metadata {
        FrameMetadata::Can { can_id, dlc, flags } => {
            let is_extended = (flags & 1) != 0;
            let is_fd = iface_type == IFACE_CANFD;

            // Find bus mapping for this interface index
            let output_bus = bus_mappings
                .iter()
                .find(|m| m.device_bus == sf.iface_index && m.enabled)
                .map(|m| m.output_bus)?;

            Some(FrameMessage {
                protocol: "can".to_string(),
                timestamp_us: now_us(),
                frame_id: *can_id,
                bus: output_bus,
                dlc: *dlc,
                bytes: sf.data.clone(),
                is_extended,
                is_fd,
                source_address: None,
                incomplete: None,
                direction: Some("rx".to_string()),
            })
        }
        FrameMetadata::Rs485 { .. } => {
            let output_bus = bus_mappings
                .iter()
                .find(|m| m.device_bus == sf.iface_index && m.enabled)
                .map(|m| m.output_bus)?;

            Some(FrameMessage {
                protocol: "serial".to_string(),
                timestamp_us: now_us(),
                frame_id: 0,
                bus: output_bus,
                dlc: sf.data.len() as u8,
                bytes: sf.data.clone(),
                is_extended: false,
                is_fd: false,
                source_address: None,
                incomplete: None,
                direction: Some("rx".to_string()),
            })
        }
        FrameMetadata::Unknown { .. } => {
            tlog!(
                "[framelink] Unknown frame metadata on interface {}",
                sf.iface_index
            );
            None
        }
    }
}

/// Encode a CAN transmit frame into FrameLink FRAME_TX payload.
pub fn encode_framelink_can_tx(frame: &CanTransmitFrame) -> Vec<u8> {
    let meta = FrameMetadata::Can {
        can_id: frame.frame_id,
        dlc: frame.data.len() as u8,
        flags: if frame.is_extended { 1 } else { 0 },
    };
    build_frame_tx(frame.bus, &meta, &frame.data)
}

/// Encode raw bytes into FrameLink FRAME_TX payload for RS-485 transmit.
pub fn encode_framelink_serial_tx(data: &[u8], iface_index: u8) -> Vec<u8> {
    let meta = FrameMetadata::Rs485 { framing_mode: 0 };
    build_frame_tx(iface_index, &meta, data)
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Probe a FrameLink device and return its interfaces.
#[tauri::command(rename_all = "snake_case")]
pub async fn framelink_probe_device(
    host: String,
    port: u16,
    timeout: Option<f64>,
) -> Result<FrameLinkProbeResult, String> {
    probe_framelink(&host, port, timeout.unwrap_or(5.0)).await
}

// ============================================================================
// Signal Types
// ============================================================================

#[derive(Debug, Serialize)]
pub struct SignalDescriptor {
    pub signal_id: u16,
    pub name: String,
    pub group: String,
    pub unit: String,
    /// "bool", "enum", "number", "temperature_0.1", etc.
    pub format: String,
    /// numeric_key → label (for enum signals)
    pub enum_values: HashMap<String, String>,
    pub writable: bool,
    pub persistable: bool,
    pub value: u64,
    pub formatted_value: String,
    /// Interface type (1=CAN, 2=CANFD, 3=RS-485, 4=RS-232)
    pub iface_type: u8,
}

#[derive(Debug, Serialize)]
pub struct SignalReadResult {
    pub signal_id: u16,
    pub value: u64,
    pub value_len: u8,
}

// ============================================================================
// Signal Tauri Commands
// ============================================================================

/// Read all device signals for a given interface, enriched with board def metadata.
#[tauri::command(rename_all = "snake_case")]
pub async fn framelink_get_interface_signals(
    host: String,
    port: u16,
    iface_index: u8,
    timeout: Option<f64>,
) -> Result<Vec<SignalDescriptor>, String> {
    let timeout_sec = timeout.unwrap_or(5.0);

    // 1. List all device signals
    let list_payload = dsig::build_list_request();
    let list_frame = shared::request(
        &host, port, MSG_DSIG_LIST, FLAG_ACK_REQ, &list_payload, timeout_sec,
    )
    .await?;
    let all_signals = dsig::parse_list_response(&list_frame.payload)
        .map_err(|e| format!("Failed to parse signal list: {}", e))?;

    // 2. Filter to signals targeting this interface
    let iface_signals = dsig::interface_signals(&all_signals, iface_index);
    if iface_signals.is_empty() {
        return Ok(vec![]);
    }

    // 2b. Look up interface type for this index
    let iface_type = shared::get_iface_type(&host, port, iface_index).await.unwrap_or(0);

    // 3. Load board def for metadata
    let board_def = shared::load_board_def(&host, port).await;

    // 4. Read current value for each signal and build descriptors
    let mut descriptors = Vec::with_capacity(iface_signals.len());
    for sig in &iface_signals {
        let read_payload = dsig::build_read_request(sig.signal_id);
        let value = match shared::request(
            &host, port, MSG_DSIG_READ, FLAG_ACK_REQ, &read_payload, timeout_sec,
        )
        .await
        {
            Ok(frame) => match dsig::parse_read_response(&frame.payload) {
                Ok(sv) => sv.value,
                Err(_) => 0,
            },
            Err(_) => 0,
        };

        let (name, group, unit, format, enum_values, formatted_value) =
            if let Some(ref bd) = board_def {
                if let Some(info) = bd.signal_info(sig.signal_id) {
                    let ev: HashMap<String, String> = info
                        .enum_values
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.clone()))
                        .collect();
                    let fv = bd.format_value(sig.signal_id, value);
                    (
                        info.name.clone(),
                        info.group.clone(),
                        info.unit.clone(),
                        info.format.clone(),
                        ev,
                        fv,
                    )
                } else {
                    default_signal_meta(sig, value)
                }
            } else {
                default_signal_meta(sig, value)
            };

        descriptors.push(SignalDescriptor {
            signal_id: sig.signal_id,
            name,
            group,
            unit,
            format,
            enum_values,
            writable: sig.is_writable(),
            persistable: sig.is_persistable(),
            value,
            formatted_value,
            iface_type,
        });
    }

    Ok(descriptors)
}

/// Write a device signal value, with optional persist.
#[tauri::command(rename_all = "snake_case")]
pub async fn framelink_write_signal(
    host: String,
    port: u16,
    signal_id: u16,
    value: u64,
    persist: bool,
    timeout: Option<f64>,
) -> Result<(), String> {
    let timeout_sec = timeout.unwrap_or(5.0);

    let write_payload = dsig::build_write_request(signal_id, value);
    shared::request(&host, port, MSG_DSIG_WRITE, FLAG_ACK_REQ, &write_payload, timeout_sec)
        .await?;

    if persist {
        let persist_payload = framelink::protocol::persist::build_persist_save();
        shared::request(
            &host, port, MSG_PERSIST_SAVE, FLAG_ACK_REQ, &persist_payload, timeout_sec,
        )
        .await?;
    }

    Ok(())
}

/// Read a single device signal value.
#[tauri::command(rename_all = "snake_case")]
pub async fn framelink_read_signal(
    host: String,
    port: u16,
    signal_id: u16,
    timeout: Option<f64>,
) -> Result<SignalReadResult, String> {
    let timeout_sec = timeout.unwrap_or(5.0);
    let read_payload = dsig::build_read_request(signal_id);
    let frame = shared::request(
        &host, port, MSG_DSIG_READ, FLAG_ACK_REQ, &read_payload, timeout_sec,
    )
    .await?;
    let sv = dsig::parse_read_response(&frame.payload)
        .map_err(|e| format!("Failed to parse signal read: {}", e))?;
    Ok(SignalReadResult {
        signal_id: sv.signal_id,
        value: sv.value,
        value_len: sv.value_len,
    })
}

fn default_signal_meta(
    sig: &dsig::SignalInfo,
    value: u64,
) -> (String, String, String, String, HashMap<String, String>, String) {
    let name = framelink::protocol::types::property_name(sig.property_id).to_string();
    (
        name,
        "Interface".to_string(),
        String::new(),
        "number".to_string(),
        HashMap::new(),
        value.to_string(),
    )
}

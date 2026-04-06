// io/broker/spawner.rs
//
// Per-protocol source spawning for broker sessions.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio::time::{Duration, interval};
use tokio_modbus::client::{self, tcp};
use tokio_modbus::prelude::*;

use super::types::ModbusRole;
use crate::io::gvret::{run_gvret_tcp_source, BusMapping};
#[cfg(not(target_os = "ios"))]
use crate::io::gvret::run_gvret_usb_source;
use crate::io::modbus_tcp::{PollGroup, RegisterType};
use crate::io::{now_us, FrameMessage};
#[cfg(not(target_os = "ios"))]
use crate::io::serial::{parse_profile_for_source, run_source as run_serial_source};
#[cfg(not(target_os = "ios"))]
use crate::io::slcan::run_slcan_source;
use crate::io::framelink::reader::run_source as run_framelink_source;
use crate::io::types::{SourceMessage, TransmitRequest};
use crate::settings::IOProfile;
use super::{VirtualBusCommand, VirtualBusControl, VirtualBusControls};

#[cfg(target_os = "linux")]
use crate::io::socketcan::run_source as run_socketcan_source;

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::io::gs_usb::run_source as run_gs_usb_source;

/// Run a single source reader and send frames to the merge task
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_source_reader(
    _app: AppHandle,
    _session_id: String,
    source_idx: usize,
    profile: IOProfile,
    bus_mappings: Vec<BusMapping>,
    _display_name: String,
    // Framing config from session options (overrides profile settings for serial)
    // Note: Prefixed with _ as these are only used on desktop (serial not available on iOS)
    _framing_encoding_override: Option<String>,
    _delimiter_override: Option<Vec<u8>>,
    _max_frame_length_override: Option<usize>,
    _min_frame_length_override: Option<usize>,
    _emit_raw_bytes_override: Option<bool>,
    // Frame ID extraction config from session options (overrides profile settings for serial)
    _frame_id_start_byte_override: Option<i32>,
    _frame_id_bytes_override: Option<u8>,
    _frame_id_big_endian_override: Option<bool>,
    _source_address_start_byte_override: Option<i32>,
    _source_address_bytes_override: Option<u8>,
    _source_address_big_endian_override: Option<bool>,
    // Modbus-specific config
    _modbus_polls: Option<Vec<PollGroup>>,
    _modbus_role: Option<ModbusRole>,
    _max_register_errors: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
    virtual_bus_controls: VirtualBusControls,
    virtual_cmd_rx: Option<mpsc::UnboundedReceiver<VirtualBusCommand>>,
) {
    match profile.kind.as_str() {
        "gvret_tcp" | "gvret-tcp" => {
            run_gvret_tcp_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" | "gvret-usb" => {
            run_gvret_usb_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        #[cfg(not(target_os = "ios"))]
        "slcan" => {
            run_slcan_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        "gs_usb" => {
            run_gs_usb_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        #[cfg(target_os = "linux")]
        "socketcan" => {
            run_socketcan_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        #[cfg(not(target_os = "ios"))]
        "serial" => {
            run_serial_reader(
                source_idx,
                &profile,
                bus_mappings,
                _framing_encoding_override,
                _delimiter_override,
                _max_frame_length_override,
                _min_frame_length_override,
                _emit_raw_bytes_override,
                _frame_id_start_byte_override,
                _frame_id_bytes_override,
                _frame_id_big_endian_override,
                _source_address_start_byte_override,
                _source_address_bytes_override,
                _source_address_big_endian_override,
                stop_flag,
                tx,
            )
            .await;
        }
        "framelink" => {
            run_framelink_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await;
        }
        "virtual" => {
            run_virtual_reader(source_idx, &profile, bus_mappings, stop_flag, tx, virtual_bus_controls, virtual_cmd_rx).await;
        }
        "modbus_tcp" => {
            let role = _modbus_role.unwrap_or(ModbusRole::Client);
            match role {
                ModbusRole::Client => {
                    run_modbus_tcp_client(
                        source_idx,
                        &profile,
                        bus_mappings,
                        _modbus_polls.unwrap_or_default(),
                        _max_register_errors.unwrap_or(0),
                        stop_flag,
                        pause_flag,
                        tx,
                    )
                    .await;
                }
                ModbusRole::Server => {
                    run_modbus_tcp_server(
                        source_idx,
                        &profile,
                        bus_mappings,
                        stop_flag,
                        tx,
                    )
                    .await;
                }
            }
        }
        kind => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Unsupported source type for multi-bus: {}", kind),
                ))
                .await;
        }
    }
}

// ============================================================================
// Per-Protocol Reader Functions
// ============================================================================

async fn run_gvret_tcp_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let host = profile
        .connection
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = profile
        .connection
        .get("port")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(23) as u16;
    let timeout_sec = profile
        .connection
        .get("timeout")
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(5.0);

    run_gvret_tcp_source(source_idx, host, port, timeout_sec, bus_mappings, stop_flag, tx).await;
}

#[cfg(not(target_os = "ios"))]
async fn run_gvret_usb_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let port = match profile.connection.get("port").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "Serial port is required".to_string(),
                ))
                .await;
            return;
        }
    };
    let baud_rate = profile
        .connection
        .get("baud_rate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(115200) as u32;

    run_gvret_usb_source(source_idx, port, baud_rate, bus_mappings, stop_flag, tx).await;
}

#[cfg(not(target_os = "ios"))]
async fn run_slcan_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let port = match profile.connection.get("port").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "Serial port is required".to_string(),
                ))
                .await;
            return;
        }
    };
    let baud_rate = profile
        .connection
        .get("baud_rate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(115200) as u32;
    let bitrate = profile
        .connection
        .get("bitrate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(500_000) as u32;
    let silent_mode = profile
        .connection
        .get("silent_mode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let enable_fd = profile
        .connection
        .get("enable_fd")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let data_bitrate = profile
        .connection
        .get("data_bitrate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(2_000_000) as u32;

    run_slcan_source(
        source_idx,
        port,
        baud_rate,
        bitrate,
        silent_mode,
        enable_fd,
        data_bitrate,
        bus_mappings,
        stop_flag,
        tx,
    )
    .await;
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn run_gs_usb_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let bus = profile
        .connection
        .get("bus")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0) as u8;
    let address = profile
        .connection
        .get("address")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0) as u8;
    let serial = profile
        .connection
        .get("serial")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let bitrate = profile
        .connection
        .get("bitrate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(500_000) as u32;
    let sample_point = profile
        .connection
        .get("sample_point")
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(87.5) as f32;
    let listen_only = profile
        .connection
        .get("listen_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let channel = profile
        .connection
        .get("channel")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0) as u8;
    let enable_fd = profile
        .connection
        .get("enable_fd")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let data_bitrate = profile
        .connection
        .get("data_bitrate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(2_000_000) as u32;
    let data_sample_point = profile
        .connection
        .get("data_sample_point")
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(75.0) as f32;

    run_gs_usb_source(
        source_idx,
        bus,
        address,
        serial,
        bitrate,
        sample_point,
        listen_only,
        channel,
        enable_fd,
        data_bitrate,
        data_sample_point,
        bus_mappings,
        stop_flag,
        tx,
    )
    .await;
}

#[cfg(target_os = "linux")]
async fn run_socketcan_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let interface = match profile.connection.get("interface").and_then(|v| v.as_str()) {
        Some(i) => i.to_string(),
        None => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "SocketCAN interface is required".to_string(),
                ))
                .await;
            return;
        }
    };

    // Optional bitrate - if set, interface will be configured automatically
    let bitrate = profile
        .connection
        .get("bitrate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok());
    let enable_fd = profile
        .connection
        .get("enable_fd")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let data_bitrate = profile
        .connection
        .get("data_bitrate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .map(|v| v as u32);

    run_socketcan_source(
        source_idx,
        interface,
        bitrate,
        enable_fd,
        data_bitrate,
        bus_mappings,
        stop_flag,
        tx,
    )
    .await;
}

#[cfg(not(target_os = "ios"))]
async fn run_serial_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    framing_encoding_override: Option<String>,
    delimiter_override: Option<Vec<u8>>,
    max_frame_length_override: Option<usize>,
    min_frame_length_override: Option<usize>,
    emit_raw_bytes_override: Option<bool>,
    frame_id_start_byte_override: Option<i32>,
    frame_id_bytes_override: Option<u8>,
    frame_id_big_endian_override: Option<bool>,
    source_address_start_byte_override: Option<i32>,
    source_address_bytes_override: Option<u8>,
    source_address_big_endian_override: Option<bool>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    use crate::io::serial::FrameIdConfig;

    let config = match parse_profile_for_source(
        profile,
        framing_encoding_override.as_deref(),
        delimiter_override,
        max_frame_length_override,
        min_frame_length_override,
        emit_raw_bytes_override,
    ) {
        Some(c) => c,
        None => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "Serial port is required".to_string(),
                ))
                .await;
            return;
        }
    };

    // Build frame_id_config: prefer session overrides, fall back to profile config
    let frame_id_config = if frame_id_start_byte_override.is_some() {
        Some(FrameIdConfig {
            start_byte: frame_id_start_byte_override.unwrap_or(0),
            num_bytes: frame_id_bytes_override.unwrap_or(1),
            big_endian: frame_id_big_endian_override.unwrap_or(true),
        })
    } else {
        config.frame_id_config
    };

    // Build source_address_config: prefer session overrides, fall back to profile config
    let source_address_config = if source_address_start_byte_override.is_some() {
        Some(FrameIdConfig {
            start_byte: source_address_start_byte_override.unwrap_or(0),
            num_bytes: source_address_bytes_override.unwrap_or(1),
            big_endian: source_address_big_endian_override.unwrap_or(true),
        })
    } else {
        config.source_address_config
    };

    tlog!(
        "[multi_source] Serial source {} using framing: {:?} (override: {:?}), frame_id_config: {:?}",
        source_idx, config.framing_encoding, framing_encoding_override, frame_id_config
    );

    run_serial_source(
        source_idx,
        config.port,
        config.baud_rate,
        config.data_bits,
        config.stop_bits,
        config.parity,
        config.framing_encoding,
        frame_id_config,
        source_address_config,
        config.min_frame_length,
        config.emit_raw_bytes,
        bus_mappings,
        stop_flag,
        tx,
    )
    .await;
}

// ============================================================================
// FrameLink Source
// ============================================================================

async fn run_framelink_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let host = match profile.connection.get("host").and_then(|v| v.as_str()) {
        Some(h) => h.to_string(),
        None => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "FrameLink profile missing 'host'".to_string(),
                ))
                .await;
            return;
        }
    };
    let port = profile
        .connection
        .get("port")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(120) as u16;
    let timeout = profile
        .connection
        .get("timeout")
        .and_then(|v| v.as_f64())
        .unwrap_or(5.0);

    run_framelink_source(source_idx, host, port, timeout, bus_mappings, stop_flag, tx).await;
}

// ============================================================================
// Virtual CAN Source
// ============================================================================

/// Virtual CAN source for multi-source sessions: generates synthetic frames and sends
/// them via the merge channel (merge task handles emission).
///
/// Parses the same `interfaces` array config as `VirtualSource` in virtual_device/mod.rs,
/// spawning one generator task per bus with independent frame rates and patterns.
async fn run_virtual_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
    virtual_bus_controls: VirtualBusControls,
    virtual_cmd_rx: Option<mpsc::UnboundedReceiver<VirtualBusCommand>>,
) {
    use crate::io::virtual_device::canfd_patterns;
    use std::collections::HashMap;

    // Parse traffic type
    let traffic_type = match profile.connection.get("traffic_type").and_then(|v| v.as_str()) {
        Some("canfd") => "canfd",
        Some("modbus") => "modbus",
        _ => "can",
    };

    // Parse per-bus interface configs from connection.interfaces array.
    // Falls back to legacy bus_count / frame_rate_hz / signal_generator fields.
    struct IfaceConfig {
        bus: u8,
        signal_generator: bool,
        frame_rate_hz: f64,
    }

    let interfaces: Vec<IfaceConfig> = profile
        .connection
        .get("interfaces")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let bus = item
                        .get("bus")
                        .and_then(|v| v.as_i64().map(|n| n as u8).or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0);
                    let signal_generator = item
                        .get("signal_generator")
                        .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s != "false")))
                        .unwrap_or(true);
                    let frame_rate_hz = item
                        .get("frame_rate_hz")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(10.0)
                        .clamp(0.1, 1000.0);
                    Some(IfaceConfig { bus, signal_generator, frame_rate_hz })
                })
                .collect()
        })
        .unwrap_or_else(|| {
            // Legacy fallback
            let frame_rate_hz = profile
                .connection
                .get("frame_rate_hz")
                .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64()))
                .unwrap_or(10.0)
                .clamp(0.1, 1000.0);
            let signal_generator = profile
                .connection
                .get("signal_generator")
                .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s != "false")))
                .unwrap_or(true);
            let bus_count = profile
                .connection
                .get("bus_count")
                .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64().map(|n| n as u8)))
                .unwrap_or(1)
                .clamp(1, 8);
            (0..bus_count)
                .map(|bus| IfaceConfig { bus, signal_generator, frame_rate_hz })
                .collect()
        });

    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "virtual".to_string(),
            "virtual://internal".to_string(),
            None,
        ))
        .await;

    // Create transmit channel for loopback: transmitted frames are echoed back as received
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    // Spawn loopback task: receives encoded frames and echoes them back via the merge channel
    let tx_loopback = tx.clone();
    let stop_flag_for_transmit = stop_flag.clone();
    tokio::spawn(async move {
        while !stop_flag_for_transmit.load(Ordering::Relaxed) {
            match transmit_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(req) => {
                    let data = &req.data;
                    // Decode virtual frame format: frame_id(4 LE) + bus(1) + is_extended(1) + is_fd(1) + dlc(1) + data
                    if data.len() >= 8 {
                        let frame_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                        let bus = data[4];
                        let is_extended = data[5] != 0;
                        let is_fd = data[6] != 0;
                        let dlc = data[7];
                        let frame_data = data.get(8..).unwrap_or(&[]).to_vec();
                        let ts = now_us();
                        let frame = FrameMessage {
                            protocol: "can".to_string(),
                            timestamp_us: ts,
                            frame_id,
                            bus,
                            dlc,
                            bytes: frame_data,
                            is_extended,
                            is_fd,
                            source_address: None,
                            incomplete: None,
                            direction: Some("rx".to_string()),
                        };
                        let _ = tx_loopback
                            .send(SourceMessage::Frames(source_idx, vec![frame]))
                            .await;
                    }
                    let _ = req.result_tx.send(Ok(()));
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    // Pre-compute CAN-FD patterns once (shared across bus tasks via Arc)
    let canfd_pats = if traffic_type == "canfd" {
        Arc::new(canfd_patterns())
    } else {
        Arc::new(Vec::new())
    };

    // Register per-bus controls in the shared map and spawn generator tasks for buses
    // that have an enabled mapping (or all buses when no mappings are configured)
    let mut gen_handles: HashMap<u8, tokio::task::JoinHandle<()>> = HashMap::new();
    for iface in &interfaces {
        // Skip buses that have no enabled mapping (but allow all when mappings are empty)
        if !bus_mappings.is_empty() && !bus_mappings.iter().any(|m| m.device_bus == iface.bus && m.enabled) {
            continue;
        }
        let handle = spawn_bus_generator(
            iface.bus,
            iface.signal_generator,
            iface.frame_rate_hz,
            traffic_type,
            source_idx,
            &bus_mappings,
            &stop_flag,
            &tx,
            &virtual_bus_controls,
            &canfd_pats,
        );
        gen_handles.insert(iface.bus, handle);
    }

    // Command-driven loop: listen for add/remove bus commands until session stops
    if let Some(mut cmd_rx) = virtual_cmd_rx {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            // Use a short timeout so we can check stop_flag periodically
            match tokio::time::timeout(Duration::from_millis(100), cmd_rx.recv()).await {
                Ok(Some(VirtualBusCommand::AddBus { bus, traffic_type: tt, frame_rate_hz })) => {
                    // Don't add if already exists
                    if gen_handles.contains_key(&bus) {
                        tlog!("[virtual_reader] Bus {} already exists, skipping add", bus);
                        continue;
                    }
                    // Skip if bus has no enabled mapping
                    if !bus_mappings.is_empty() && !bus_mappings.iter().any(|m| m.device_bus == bus && m.enabled) {
                        tlog!("[virtual_reader] Bus {} has no enabled mapping, skipping add", bus);
                        continue;
                    }
                    let tt_str = match tt.as_str() {
                        "canfd" => "canfd",
                        "modbus" => "modbus",
                        _ => "can",
                    };
                    let handle = spawn_bus_generator(
                        bus,
                        true,
                        frame_rate_hz,
                        tt_str,
                        source_idx,
                        &bus_mappings,
                        &stop_flag,
                        &tx,
                        &virtual_bus_controls,
                        &canfd_pats,
                    );
                    gen_handles.insert(bus, handle);
                    tlog!("[virtual_reader] Added bus {} at {:.0} Hz", bus, frame_rate_hz);
                }
                Ok(Some(VirtualBusCommand::RemoveBus { bus })) => {
                    // Set bus_stop flag so the generator exits on next tick
                    if let Ok(mut controls) = virtual_bus_controls.lock() {
                        if let Some(ctrl) = controls.get(&bus) {
                            ctrl.bus_stop.store(true, Ordering::Relaxed);
                        }
                        controls.remove(&bus);
                    }
                    // Await the handle
                    if let Some(handle) = gen_handles.remove(&bus) {
                        let _ = handle.await;
                    }
                    tlog!("[virtual_reader] Removed bus {}", bus);
                }
                Ok(None) => {
                    // Channel closed — session ending
                    break;
                }
                Err(_) => {
                    // Timeout — loop back to check stop_flag
                }
            }
        }
    } else {
        // No command channel — just wait for stop (legacy path, shouldn't happen)
        while !stop_flag.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // Wait for all remaining generator tasks to finish
    for (_bus, handle) in gen_handles {
        let _ = handle.await;
    }

    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}

/// Spawn a single bus generator task and register its controls in the shared map.
fn spawn_bus_generator(
    bus: u8,
    signal_generator: bool,
    frame_rate_hz: f64,
    traffic_type: &str,
    source_idx: usize,
    bus_mappings: &[BusMapping],
    stop_flag: &Arc<AtomicBool>,
    tx: &mpsc::Sender<SourceMessage>,
    virtual_bus_controls: &VirtualBusControls,
    canfd_pats: &Arc<Vec<(u32, Vec<u8>)>>,
) -> tokio::task::JoinHandle<()> {
    use crate::io::virtual_device::{CAN_PATTERNS, MODBUS_REGISTERS};

    let hz = frame_rate_hz.clamp(0.1, 1000.0);
    let initial_interval_us = (1_000_000.0 / hz) as u64;
    let traffic_enabled = Arc::new(AtomicBool::new(signal_generator));
    let interval_us_atomic = Arc::new(AtomicU64::new(initial_interval_us));
    let bus_stop = Arc::new(AtomicBool::new(false));

    // Register in shared controls map so the session can modify at runtime
    if let Ok(mut controls) = virtual_bus_controls.lock() {
        controls.insert(bus, VirtualBusControl {
            traffic_enabled: traffic_enabled.clone(),
            interval_us: interval_us_atomic.clone(),
            bus_stop: bus_stop.clone(),
        });
    }

    let tx_clone = tx.clone();
    let stop_clone = stop_flag.clone();
    let bus_mappings_clone = bus_mappings.to_vec();
    let canfd_pats_clone = canfd_pats.clone();
    let traffic = traffic_type.to_string();

    tokio::spawn(async move {
        let mut current_interval_us = initial_interval_us;
        let mut ticker = interval(Duration::from_micros(current_interval_us));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Map device bus to output bus
        let output_bus = bus_mappings_clone
            .iter()
            .find(|m| m.device_bus == bus)
            .map(|m| m.output_bus)
            .unwrap_or(bus);

        let mut counter: u64 = 0;

        loop {
            ticker.tick().await;

            if stop_clone.load(Ordering::Relaxed) || bus_stop.load(Ordering::Relaxed) {
                break;
            }

            // Check if cadence changed at runtime
            let new_interval_us = interval_us_atomic.load(Ordering::Relaxed);
            if new_interval_us != current_interval_us {
                current_interval_us = new_interval_us;
                ticker = interval(Duration::from_micros(current_interval_us));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                // Consume the immediate first tick
                ticker.tick().await;
            }

            // Skip frame generation if signal generator is disabled for this bus
            if !traffic_enabled.load(Ordering::Relaxed) {
                continue;
            }

            let ts = now_us();

            let frame = match traffic.as_str() {
                "canfd" => {
                    let pattern_idx = (counter as usize) % (canfd_pats_clone.len() + 1);
                    let (frame_id, data) = if pattern_idx < canfd_pats_clone.len() {
                        let (id, ref pat) = canfd_pats_clone[pattern_idx];
                        (id, pat.clone())
                    } else {
                        // Counter frame (0x7E0) — 64 bytes
                        let cycle = (counter / (canfd_pats_clone.len() as u64 + 1)) + 1;
                        let c = (cycle as u16).to_be_bytes();
                        (0x7E0, vec![c[0], c[1]].into_iter().cycle().take(64).collect())
                    };
                    FrameMessage {
                        protocol: "can".to_string(),
                        timestamp_us: ts,
                        frame_id,
                        bus: output_bus,
                        dlc: data.len() as u8,
                        bytes: data,
                        is_extended: false,
                        is_fd: true,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    }
                }
                "modbus" => {
                    let reg_idx = (counter as usize) % MODBUS_REGISTERS.len();
                    let register = MODBUS_REGISTERS[reg_idx];
                    let value = ((counter / MODBUS_REGISTERS.len() as u64) & 0xFFFF) as u16;
                    let bytes = value.to_be_bytes().to_vec();
                    FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: ts,
                        frame_id: register,
                        bus: output_bus,
                        dlc: bytes.len() as u8,
                        bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    }
                }
                _ => {
                    // Classic CAN
                    let pattern_idx = (counter as usize) % (CAN_PATTERNS.len() + 1);
                    let (frame_id, data) = if pattern_idx < CAN_PATTERNS.len() {
                        let (id, pat) = CAN_PATTERNS[pattern_idx];
                        (id, pat.to_vec())
                    } else {
                        let cycle = (counter / (CAN_PATTERNS.len() as u64 + 1)) + 1;
                        let c = (cycle as u16).to_be_bytes();
                        (0x7E0, vec![c[0], c[1], c[0], c[1], c[0], c[1], c[0], c[1]])
                    };
                    FrameMessage {
                        protocol: "can".to_string(),
                        timestamp_us: ts,
                        frame_id,
                        bus: output_bus,
                        dlc: data.len() as u8,
                        bytes: data,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    }
                }
            };

            if tx_clone.send(SourceMessage::Frames(source_idx, vec![frame])).await.is_err() {
                break;
            }

            counter = counter.wrapping_add(1);
        }
    })
}

// ============================================================================
// Modbus TCP Source Functions
// ============================================================================

/// Modbus TCP client source: connects to a Modbus TCP server and polls registers.
/// Extracted from ModbusTcpSource to work within the multi-source framework.
async fn run_modbus_tcp_client(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    polls: Vec<PollGroup>,
    max_register_errors: u32,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let host = profile
        .connection
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port = profile
        .connection
        .get("port")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| v.as_i64().map(|n| n as u16))
        })
        .unwrap_or(502);
    let unit_id = profile
        .connection
        .get("unit_id")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| v.as_i64().map(|n| n as u8))
        })
        .unwrap_or(1);

    let output_bus = bus_mappings
        .first()
        .map(|m| m.output_bus)
        .unwrap_or(0);

    if polls.is_empty() {
        tlog!(
            "[ModbusTCP] Source {} has no poll groups — waiting for catalog reinitialise",
            source_idx
        );
        let _ = tx
            .send(SourceMessage::Ended(
                source_idx,
                "no_polls".to_string(),
            ))
            .await;
        return;
    }

    // Resolve server address
    let addr: SocketAddr = match format!("{}:{}", host, port).parse() {
        Ok(a) => a,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Invalid Modbus server address {}:{}: {}", host, port, e),
                ))
                .await;
            return;
        }
    };

    // Connect to the Modbus TCP server
    let slave = Slave(unit_id);
    let ctx = match tcp::connect_slave(addr, slave).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to connect to Modbus TCP server at {}: {}", addr, e),
                ))
                .await;
            return;
        }
    };

    let ctx: Arc<Mutex<client::Context>> = Arc::new(Mutex::new(ctx));
    let address = format!("{}:{}", host, port);

    // Signal that we're connected
    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "modbus_tcp".to_string(),
            address.clone(),
            None,
        ))
        .await;

    tlog!(
        "[multi_source] Modbus TCP source {} connected to {} (unit {}), {} poll group(s), output_bus={}",
        source_idx, address, unit_id, polls.len(), output_bus
    );

    // Spawn one poll task per group
    let mut poll_handles = Vec::new();
    for poll in &polls {
        let tx_clone = tx.clone();
        let ctx_clone = ctx.clone();
        let stop_clone = stop_flag.clone();
        let pause_clone = pause_flag.clone();
        let poll = poll.clone();

        let handle = tokio::spawn(async move {
            run_modbus_poll_task(
                source_idx,
                output_bus,
                poll,
                ctx_clone,
                max_register_errors,
                stop_clone,
                pause_clone,
                tx_clone,
            )
            .await;
        });
        poll_handles.push(handle);
    }

    // Wait for all poll tasks to finish
    for handle in poll_handles {
        let _ = handle.await;
    }

    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}

/// Run a single Modbus poll task (one register read operation on a timer)
async fn run_modbus_poll_task(
    source_idx: usize,
    output_bus: u8,
    poll: PollGroup,
    ctx: Arc<Mutex<client::Context>>,
    max_register_errors: u32,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let mut timer = interval(Duration::from_millis(poll.interval_ms));
    let type_name = match poll.register_type {
        RegisterType::Holding => "holding",
        RegisterType::Input => "input",
        RegisterType::Coil => "coil",
        RegisterType::Discrete => "discrete",
    };
    let mut first_poll = true;
    let mut consecutive_errors: u32 = 0;

    tlog!(
        "[multi_source] Modbus source {} poll task: {} reg {} count {} every {}ms (frame_id={}, bus={})",
        source_idx, type_name, poll.start_register, poll.count, poll.interval_ms, poll.frame_id, output_bus
    );

    loop {
        timer.tick().await;

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Skip reads while paused (task stays alive, timer keeps ticking)
        if pause_flag.load(Ordering::Relaxed) {
            continue;
        }

        let mut ctx = ctx.lock().await;

        // tokio-modbus read methods return Result<Result<Vec<T>, Exception>>
        // Outer Result = IO error, Inner Result = Modbus exception
        let result: Result<Vec<u8>, String> = match poll.register_type {
            RegisterType::Holding => {
                match ctx
                    .read_holding_registers(poll.start_register, poll.count)
                    .await
                {
                    Ok(Ok(data)) => Ok(registers_to_bytes(&data)),
                    Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                    Err(e) => Err(format!("IO error: {}", e)),
                }
            }
            RegisterType::Input => {
                match ctx
                    .read_input_registers(poll.start_register, poll.count)
                    .await
                {
                    Ok(Ok(data)) => Ok(registers_to_bytes(&data)),
                    Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                    Err(e) => Err(format!("IO error: {}", e)),
                }
            }
            RegisterType::Coil => {
                match ctx
                    .read_coils(poll.start_register, poll.count)
                    .await
                {
                    Ok(Ok(data)) => Ok(coils_to_bytes(&data)),
                    Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                    Err(e) => Err(format!("IO error: {}", e)),
                }
            }
            RegisterType::Discrete => {
                match ctx
                    .read_discrete_inputs(poll.start_register, poll.count)
                    .await
                {
                    Ok(Ok(data)) => Ok(coils_to_bytes(&data)),
                    Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                    Err(e) => Err(format!("IO error: {}", e)),
                }
            }
        };

        // Release the lock before sending
        drop(ctx);

        match result {
            Ok(bytes) => {
                consecutive_errors = 0;

                if first_poll {
                    tlog!(
                        "[multi_source] Modbus source {} first poll OK: {} reg {} → {} bytes",
                        source_idx, type_name, poll.start_register, bytes.len()
                    );
                    first_poll = false;
                }

                let frame = FrameMessage {
                    protocol: "modbus".to_string(),
                    timestamp_us: now_us(),
                    frame_id: poll.frame_id,
                    bus: output_bus,
                    dlc: bytes.len() as u8,
                    bytes,
                    is_extended: false,
                    is_fd: false,
                    source_address: None,
                    incomplete: None,
                    direction: Some("rx".to_string()),
                };

                let _ = tx
                    .send(SourceMessage::Frames(source_idx, vec![frame]))
                    .await;
            }
            Err(e) => {
                consecutive_errors += 1;

                tlog!(
                    "[multi_source] Modbus source {} error reading {} at {}: {} ({}/{})",
                    source_idx, type_name, poll.start_register, e,
                    consecutive_errors,
                    if max_register_errors > 0 { max_register_errors.to_string() } else { "∞".to_string() }
                );

                if max_register_errors > 0 && consecutive_errors >= max_register_errors {
                    tlog!(
                        "[multi_source] Modbus source {} stopped polling {} reg {} after {} consecutive errors",
                        source_idx, type_name, poll.start_register, consecutive_errors
                    );
                    break;
                }
            }
        }
    }
}

// ============================================================================
// Modbus TCP Server Source (MITM)
// ============================================================================

/// Modbus TCP server source: listens for incoming Modbus TCP connections and logs requests.
/// This enables MITM scenarios where WireTAP sits between a Modbus master and slave.
async fn run_modbus_tcp_server(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let host = profile
        .connection
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0.0")
        .to_string();
    let port = profile
        .connection
        .get("port")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .or_else(|| v.as_i64().map(|n| n as u16))
        })
        .unwrap_or(5020); // Default to 5020 to avoid conflict with real Modbus on 502

    let output_bus = bus_mappings
        .first()
        .map(|m| m.output_bus)
        .unwrap_or(0);

    let bind_addr = format!("{}:{}", host, port);

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to bind Modbus TCP server on {}: {}", bind_addr, e),
                ))
                .await;
            return;
        }
    };

    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "modbus_tcp_server".to_string(),
            bind_addr.clone(),
            None,
        ))
        .await;

    tlog!(
        "[multi_source] Modbus TCP server source {} listening on {}, output_bus={}",
        source_idx, bind_addr, output_bus
    );

    // Accept connections until stopped
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Accept with timeout so we can check stop_flag
        match tokio::time::timeout(Duration::from_millis(500), listener.accept()).await {
            Ok(Ok((stream, peer_addr))) => {
                tlog!(
                    "[multi_source] Modbus TCP server source {} accepted connection from {}",
                    source_idx, peer_addr
                );

                let tx_clone = tx.clone();
                let stop_clone = stop_flag.clone();

                // Handle connection in a separate task
                tokio::spawn(async move {
                    handle_modbus_server_connection(
                        source_idx,
                        output_bus,
                        stream,
                        peer_addr,
                        stop_clone,
                        tx_clone,
                    )
                    .await;
                });
            }
            Ok(Err(e)) => {
                tlog!(
                    "[multi_source] Modbus TCP server source {} accept error: {}",
                    source_idx, e
                );
            }
            Err(_) => {
                // Timeout - check stop_flag and continue
            }
        }
    }

    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}

/// Handle a single Modbus TCP server connection, parsing MBAP frames and logging requests.
async fn handle_modbus_server_connection(
    source_idx: usize,
    output_bus: u8,
    mut stream: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    use tokio::io::AsyncReadExt;

    let mut buf = [0u8; 512];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        match tokio::time::timeout(Duration::from_millis(500), stream.read(&mut buf)).await {
            Ok(Ok(0)) => {
                tlog!(
                    "[multi_source] Modbus TCP server source {} client {} disconnected",
                    source_idx, peer_addr
                );
                break;
            }
            Ok(Ok(n)) => {
                // Parse MBAP header (7 bytes): transaction_id(2) + protocol_id(2) + length(2) + unit_id(1)
                if n >= 8 {
                    let function_code = buf[7];
                    // Use function code as frame_id for logging
                    let frame_id = function_code as u32;

                    // Extract the PDU (everything after MBAP header)
                    let pdu_bytes = buf[6..n].to_vec(); // unit_id + function_code + data

                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id,
                        bus: output_bus,
                        dlc: pdu_bytes.len() as u8,
                        bytes: pdu_bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };

                    let _ = tx
                        .send(SourceMessage::Frames(source_idx, vec![frame]))
                        .await;
                }

                // For now, don't send any response (logging only).
                // Future: relay to paired client interface for full MITM.
            }
            Ok(Err(e)) => {
                tlog!(
                    "[multi_source] Modbus TCP server source {} read error from {}: {}",
                    source_idx, peer_addr, e
                );
                break;
            }
            Err(_) => {
                // Timeout - check stop_flag and continue
            }
        }
    }
}

// ============================================================================
// Data Conversion Helpers (shared with modbus_tcp/reader.rs)
// ============================================================================

/// Convert Modbus register values (u16) to bytes in big-endian order.
fn registers_to_bytes(registers: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(registers.len() * 2);
    for &reg in registers {
        bytes.push((reg >> 8) as u8);
        bytes.push((reg & 0xFF) as u8);
    }
    bytes
}

/// Convert coil/discrete input values (bool) to packed bytes.
fn coils_to_bytes(coils: &[bool]) -> Vec<u8> {
    let byte_count = (coils.len() + 7) / 8;
    let mut bytes = vec![0u8; byte_count];
    for (i, &coil) in coils.iter().enumerate() {
        if coil {
            bytes[i / 8] |= 1 << (i % 8);
        }
    }
    bytes
}

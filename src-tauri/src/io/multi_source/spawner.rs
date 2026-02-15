// io/multi_source/spawner.rs
//
// Per-protocol source spawning for multi-source sessions.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::io::gvret::{run_gvret_tcp_source, BusMapping};
#[cfg(not(target_os = "ios"))]
use crate::io::gvret::run_gvret_usb_source;
#[cfg(not(target_os = "ios"))]
use crate::io::serial::{parse_profile_for_source, run_source as run_serial_source};
#[cfg(not(target_os = "ios"))]
use crate::io::slcan::run_slcan_source;
use crate::io::types::SourceMessage;
use crate::settings::IOProfile;

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
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
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

    run_slcan_source(
        source_idx,
        port,
        baud_rate,
        bitrate,
        silent_mode,
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

    run_gs_usb_source(
        source_idx,
        bus,
        address,
        serial,
        bitrate,
        listen_only,
        channel,
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

    run_socketcan_source(source_idx, interface, bitrate, bus_mappings, stop_flag, tx).await;
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

    eprintln!(
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

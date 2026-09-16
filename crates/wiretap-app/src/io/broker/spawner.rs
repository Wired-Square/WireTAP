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

use super::types::{SerialOverrides, SourceConfig};
use crate::io::device_kinds::{
    self, conn_bool, conn_f64, conn_i64, conn_str, req_bool, req_f64, req_i64, req_str,
};
use crate::io::bus_mapping::BusMapping;
use crate::io::gvret::run_gvret_tcp_source;
#[cfg(not(target_os = "ios"))]
use crate::io::gvret::run_gvret_usb_source;
use crate::io::modbus_tcp::poll::{run_poll_task, FrameSink};
use crate::io::modbus_tcp::PollGroup;
use crate::io::{now_us, FrameMessage};
#[cfg(not(target_os = "ios"))]
use crate::io::serial::{parse_profile_for_source, run_source as run_serial_source};
#[cfg(not(target_os = "ios"))]
use crate::io::slcan::run_slcan_source;
use crate::io::framelink::reader::run_source as run_framelink_source;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use crate::settings::IOProfile;
use super::{VirtualBusCommand, VirtualBusControl, VirtualBusControls};

#[cfg(target_os = "linux")]
use crate::io::socketcan::run_source as run_socketcan_source;

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::io::gs_usb::run_source as run_gs_usb_source;

/// Run a single source reader and send frames to the merge task.
///
/// Takes the whole `SourceConfig` rather than its fields: the serial settings
/// used to arrive here as loose parameters, re-exploded from the config by the
/// caller and re-assembled by `run_serial_reader`, and a setting missing from any
/// one of those lists was silently dropped rather than rejected.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_source_reader(
    _app: AppHandle,
    session_id: String,
    source_idx: usize,
    profile: IOProfile,
    config: SourceConfig,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
    virtual_bus_controls: VirtualBusControls,
    virtual_cmd_rx: Option<mpsc::UnboundedReceiver<VirtualBusCommand>>,
) {
    // Owned, so take the fields rather than cloning them. Only one arm runs.
    let SourceConfig {
        bus_mappings,
        serial,
        modbus_polls,
        max_register_errors,
        ..
    } = config;
    let error_tx = tx.clone();
    let outcome = match profile.kind.as_str() {
        "gvret_tcp" => {
            run_gvret_tcp_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            run_gvret_usb_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await
        }
        #[cfg(not(target_os = "ios"))]
        "slcan" => run_slcan_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await,
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        "gs_usb" => run_gs_usb_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await,
        #[cfg(target_os = "linux")]
        "socketcan" => {
            run_socketcan_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await
        }
        #[cfg(not(target_os = "ios"))]
        "serial" => {
            run_serial_reader(
                source_idx,
                &session_id,
                &profile,
                bus_mappings,
                &serial,
                stop_flag,
                tx,
            )
            .await
        }
        "framelink" => {
            run_framelink_reader(source_idx, &profile, bus_mappings, stop_flag, tx).await
        }
        "virtual" => {
            run_virtual_reader(source_idx, &profile, bus_mappings, stop_flag, tx, virtual_bus_controls, virtual_cmd_rx).await
        }
        "modbus_tcp" => {
            run_modbus_tcp_client(
                source_idx,
                &profile,
                bus_mappings,
                modbus_polls.unwrap_or_default(),
                max_register_errors.unwrap_or(0),
                stop_flag,
                pause_flag,
                tx,
            )
            .await
        }
        kind => Err(format!("Unsupported source type for multi-bus: {}", kind)),
    };

    // One place a source's setup failure is reported, rather than the same
    // send-and-return block copied into every reader.
    if let Err(e) = outcome {
        let _ = error_tx.send(SourceMessage::Error(source_idx, e)).await;
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
) -> Result<(), String> {
    let host = req_str(profile, "host")?;
    let port = req_i64(profile, "port")? as u16;
    let timeout_sec = req_f64(profile, "timeout")?;

    run_gvret_tcp_source(source_idx, host, port, timeout_sec, bus_mappings, stop_flag, tx).await;
    Ok(())
}

#[cfg(not(target_os = "ios"))]
async fn run_gvret_usb_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) -> Result<(), String> {
    let port = req_str(profile, "port")?;
    let baud_rate = req_i64(profile, "baud_rate")? as u32;

    run_gvret_usb_source(source_idx, port, baud_rate, bus_mappings, stop_flag, tx).await;
    Ok(())
}

#[cfg(not(target_os = "ios"))]
async fn run_slcan_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) -> Result<(), String> {
    let port = req_str(profile, "port")?;
    let baud_rate = req_i64(profile, "baud_rate")? as u32;
    let bitrate = req_i64(profile, "bitrate")? as u32;
    let silent_mode = req_bool(profile, "silent_mode")?;
    let enable_fd = req_bool(profile, "enable_fd")?;
    let data_bitrate = req_i64(profile, "data_bitrate")? as u32;

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
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn run_gs_usb_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) -> Result<(), String> {
    let bus = req_i64(profile, "bus")? as u8;
    let address = req_i64(profile, "address")? as u8;
    // No default: a serial number identifies one adapter among several, and
    // absent means "take whichever is there".
    let serial = conn_str(profile, "serial");
    let bitrate = req_i64(profile, "bitrate")? as u32;
    let sample_point = req_f64(profile, "sample_point")? as f32;
    let listen_only = req_bool(profile, "listen_only")?;
    let channel = req_i64(profile, "channel")? as u8;
    let enable_fd = req_bool(profile, "enable_fd")?;
    let data_bitrate = req_i64(profile, "data_bitrate")? as u32;
    let data_sample_point = req_f64(profile, "data_sample_point")? as f32;

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
    Ok(())
}

#[cfg(target_os = "linux")]
async fn run_socketcan_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) -> Result<(), String> {
    let interface = req_str(profile, "interface")?;

    // The two bitrates stay optional: absent means "leave the interface as the
    // system configured it", which is a different instruction from any rate.
    let bitrate = conn_i64(profile, "bitrate").map(|v| v as u32);
    let data_bitrate = conn_i64(profile, "data_bitrate").map(|v| v as u32);
    let enable_fd = req_bool(profile, "enable_fd")?;

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
    Ok(())
}

#[cfg(not(target_os = "ios"))]
async fn run_serial_reader(
    source_idx: usize,
    session_id: &str,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    overrides: &SerialOverrides,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) -> Result<(), String> {
    // Fully resolved — the overrides go in, so nothing is left to re-apply here.
    let config = parse_profile_for_source(profile, overrides).ok_or("Serial port is required")?;

    // The WS decode path frames these messages a second time, and has to be told
    // the same vendor codes or it discards what the port framed.
    if let crate::io::serial::FramingEncoding::ModbusRtu(opts) = &config.framing_encoding {
        crate::ws::dispatch::set_serial_rtu_options(session_id, opts.clone());
    }

    tlog!(
        "[multi_source] Serial source {} using framing: {:?} (override: {:?}), frame_id_config: {:?}",
        source_idx, config.framing_encoding, overrides.framing_encoding, config.frame_id_config
    );

    run_serial_source(
        source_idx,
        config.port,
        config.baud_rate,
        config.data_bits,
        config.stop_bits,
        config.parity,
        config.framing_encoding,
        config.frame_id_config,
        config.source_address_config,
        config.min_frame_length,
        config.emit_raw_bytes,
        bus_mappings,
        stop_flag,
        tx,
    )
    .await;
    Ok(())
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
) -> Result<(), String> {
    let host = req_str(profile, "host")?;
    let port = req_i64(profile, "port")? as u16;
    let timeout = req_f64(profile, "timeout")?;

    run_framelink_source(source_idx, host, port, timeout, bus_mappings, stop_flag, tx).await;
    Ok(())
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
) -> Result<(), String> {
    use crate::io::virtual_device::canfd_patterns;
    use std::collections::HashMap;

    // Parse traffic type
    let traffic_type = match conn_str(profile, "traffic_type").as_deref() {
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

    // Clamps are validation, not defaults, so they live with the reader — but
    // the values they clamp towards come from the one table.
    let (rate_min, rate_max) = device_kinds::VIRTUAL_FRAME_RATE_RANGE;
    let (bus_min, bus_max) = device_kinds::VIRTUAL_BUS_COUNT_RANGE;

    let interfaces: Vec<IfaceConfig> = profile
        .connection
        .get("interfaces")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| {
                    let bus = item
                        .get("bus")
                        .and_then(|v| v.as_i64().map(|n| n as u8).or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0);
                    let signal_generator = item
                        .get("signal_generator")
                        .and_then(|v| v.as_bool().or_else(|| v.as_str().map(|s| s != "false")))
                        .unwrap_or(device_kinds::VIRTUAL_SIGNAL_GENERATOR);
                    let frame_rate_hz = item
                        .get("frame_rate_hz")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(device_kinds::VIRTUAL_FRAME_RATE_HZ)
                        .clamp(rate_min, rate_max);
                    IfaceConfig { bus, signal_generator, frame_rate_hz }
                })
                .collect()
        })
        .unwrap_or_else(|| {
            // Legacy fallback: one interface per bus, from the top-level fields,
            // which the table declares.
            let frame_rate_hz = conn_f64(profile, "frame_rate_hz")
                .unwrap_or(device_kinds::VIRTUAL_FRAME_RATE_HZ)
                .clamp(rate_min, rate_max);
            let signal_generator = conn_bool(profile, "signal_generator")
                .unwrap_or(device_kinds::VIRTUAL_SIGNAL_GENERATOR);
            let bus_count = conn_i64(profile, "bus_count")
                .unwrap_or(1)
                .clamp(bus_min as i64, bus_max as i64) as u8;
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
        .send(SourceMessage::Ended(source_idx, EndReason::Stopped))
        .await;
    Ok(())
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
) -> Result<(), String> {
    let (host, port, unit_id) = crate::io::modbus_endpoint(profile);

    let output_bus = bus_mappings
        .first()
        .map(|m| m.output_bus)
        .unwrap_or(0);

    if polls.is_empty() {
        tlog!(
            "[ModbusTCP] Source {} has no poll groups — waiting for catalog reinitialise",
            source_idx
        );
        // Deliberate, not a fault: the source stands down until a catalogue
        // gives it something to poll.
        let _ = tx.send(SourceMessage::Ended(source_idx, EndReason::Stopped)).await;
        return Ok(());
    }

    // Resolve server address (accepts a hostname or an IP literal)
    let addr: SocketAddr = crate::io::net::resolve_host_port(&host, port)
        .await
        .map_err(|e| e.user_message())?;

    // Connect to the Modbus TCP server
    let slave = Slave(unit_id);
    let ctx = tcp::connect_slave(addr, slave)
        .await
        .map_err(|e| format!("Failed to connect to Modbus TCP server at {}: {}", addr, e))?;

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
            run_poll_task(
                poll,
                ctx_clone,
                max_register_errors,
                stop_clone,
                pause_clone,
                FrameSink::Broker {
                    source_idx,
                    tx: tx_clone,
                },
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
        .send(SourceMessage::Ended(source_idx, EndReason::Stopped))
        .await;
    Ok(())
}

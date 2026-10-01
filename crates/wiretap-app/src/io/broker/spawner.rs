// io/broker/spawner.rs
//
// Per-protocol source spawning for broker sessions.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::{mpsc, watch};
use tokio::time::{Duration, interval};

use super::types::{SerialOverrides, SourceConfig};
use crate::io::device_kinds::{
    self, conn_bool, conn_f64, conn_i64, conn_str, req_bool, req_f64, req_i64, req_str,
};
use crate::io::bus_mapping::{apply_bus_mapping, BusMapping};
use crate::io::gvret::run_gvret_tcp_source;
#[cfg(not(target_os = "ios"))]
use crate::io::gvret::run_gvret_usb_source;
use crate::io::modbus_tcp::poll::{
    register_writer, run_poll_task, start_polling, FrameSink, PollControl,
};
use crate::io::modbus_tcp::PollGroup;
use crate::io::virtual_device::{traffic, VirtualTrafficType};
use crate::io::{now_us, FrameMessage};
#[cfg(not(target_os = "ios"))]
use crate::io::serial::{parse_profile_for_source, run_source as run_serial_source};
#[cfg(not(target_os = "ios"))]
use crate::io::serial::utils::line_settings;
#[cfg(not(target_os = "ios"))]
use crate::io::slcan::{reader::slcan_rates, run_slcan_source};
use crate::io::framelink::reader::run_source as run_framelink_source;
use crate::io::types::{ByteEntry, EndReason, SourceMessage, TransmitRequest};
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
                &session_id,
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

    run_gvret_usb_source(source_idx, port, line_settings(profile)?, bus_mappings, stop_flag, tx)
        .await;
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
    let (bitrate, data_bitrate) = slcan_rates(profile)?;
    let silent_mode = req_bool(profile, "silent_mode")?;

    run_slcan_source(
        source_idx,
        port,
        line_settings(profile)?,
        bitrate,
        silent_mode,
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
    let config = parse_profile_for_source(profile, overrides)?;

    // The WS decode path frames these messages a second time, and has to be told
    // the same vendor codes or it discards what the port framed.
    if let crate::io::serial::FramingEncoding::ModbusRtu(opts) = &config.framing_encoding {
        crate::ws::dispatch::set_serial_rtu_options(session_id, opts.clone());
    }

    tlog!(
        "[multi_source] Serial source {} using framing: {:?} (override: {:?}), frame_id_config: {:?}",
        source_idx, config.framing_encoding, overrides.framing_encoding, config.frame_id_config
    );

    let session_id = session_id.to_string();
    let attached_catalog = move || crate::ws::dispatch::attached_catalog(&session_id);
    run_serial_source(
        source_idx,
        config,
        bus_mappings,
        attached_catalog,
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
/// Spawns one generator task per entry of the profile's `interfaces` array, each
/// with its own frame rate and patterns.
async fn run_virtual_reader(
    source_idx: usize,
    profile: &IOProfile,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
    virtual_bus_controls: VirtualBusControls,
    virtual_cmd_rx: Option<mpsc::UnboundedReceiver<VirtualBusCommand>>,
) -> Result<(), String> {
    use std::collections::HashMap;

    let traffic = VirtualTrafficType::from_setting(conn_str(profile, "traffic_type").as_deref());

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
    // A blocking thread, not a tokio task: `recv_timeout` never yields, and on a worker it wedged the runtime.
    let tx_loopback = tx.clone();
    let stop_flag_for_transmit = stop_flag.clone();
    let serial_echo_bus = (traffic == VirtualTrafficType::Serial).then(|| {
        bus_mappings.iter().find(|m| m.enabled).map_or(0, |m| m.output_bus)
    });
    let echo_mappings = bus_mappings.clone();
    tokio::task::spawn_blocking(move || {
        while !stop_flag_for_transmit.load(Ordering::Relaxed) {
            match transmit_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(req) => {
                    let data = &req.data;
                    if let Some(bus) = serial_echo_bus {
                        let timestamp_us = now_us();
                        let entries = data.iter().map(|&byte| ByteEntry { byte, timestamp_us, bus }).collect();
                        let _ = tx_loopback.blocking_send(SourceMessage::Bytes(source_idx, entries));
                    } else if data.len() >= 8 {
                        // Decode virtual frame format: frame_id(4 LE) + bus(1) + is_extended(1) + is_fd(1) + dlc(1) + data
                        let frame_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                        let bus = data[4];
                        let is_extended = data[5] != 0;
                        let is_fd = data[6] != 0;
                        let dlc = data[7];
                        let frame_data = data.get(8..).unwrap_or(&[]).to_vec();
                        let ts = now_us();
                        let mut frame = FrameMessage {
                            protocol: "can".to_string(),
                            timestamp_us: ts,
                            frame_id,
                            bus,
                            dlc: dlc.into(),
                            bytes: frame_data,
                            is_extended,
                            is_fd,
                            source_address: None,
                            incomplete: None,
                            direction: Some("rx".to_string()),
                        };
                        if apply_bus_mapping(&mut frame, &echo_mappings) {
                            let _ = tx_loopback.blocking_send(SourceMessage::Frames(source_idx, vec![frame]));
                        }
                    }
                    let _ = req.result_tx.send(Ok(()));
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

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
            traffic.clone(),
            source_idx,
            &bus_mappings,
            &stop_flag,
            &tx,
            &virtual_bus_controls,
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
                    let handle = spawn_bus_generator(
                        bus,
                        true,
                        frame_rate_hz,
                        VirtualTrafficType::from_setting(Some(&tt)),
                        source_idx,
                        &bus_mappings,
                        &stop_flag,
                        &tx,
                        &virtual_bus_controls,
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
    traffic: VirtualTrafficType,
    source_idx: usize,
    bus_mappings: &[BusMapping],
    stop_flag: &Arc<AtomicBool>,
    tx: &mpsc::Sender<SourceMessage>,
    virtual_bus_controls: &VirtualBusControls,
) -> tokio::task::JoinHandle<()> {
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

            let timestamp_us = now_us();
            let message = match traffic::frame(&traffic, counter, output_bus, timestamp_us) {
                Some(frame) => SourceMessage::Frames(source_idx, vec![frame]),
                None => SourceMessage::Bytes(
                    source_idx,
                    traffic::serial_bytes(counter)
                        .map(|byte| ByteEntry { byte, timestamp_us, bus: output_bus })
                        .collect(),
                ),
            };
            if tx_clone.send(message).await.is_err() {
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
async fn run_modbus_tcp_client(
    session_id: &str,
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

    let task = start_polling(&host, port, unit_id, &polls).await?;
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

    let _writer = register_writer(session_id, &profile.id, task.writer());
    let (control, control_rx) = watch::channel(PollControl::Run);
    let sink = FrameSink::Broker {
        source_idx,
        tx: tx.clone(),
    };
    tokio::select! {
        () = run_poll_task(task, control_rx, sink, max_register_errors) => {}
        () = relay_source_flags(&stop_flag, &pause_flag, &control) => {}
    }

    let _ = tx
        .send(SourceMessage::Ended(source_idx, EndReason::Stopped))
        .await;
    Ok(())
}

/// The broker signals its sources through shared flags and a poll task takes
/// commands, so this relays one to the other until it is dropped.
async fn relay_source_flags(
    stop: &AtomicBool,
    pause: &AtomicBool,
    control: &watch::Sender<PollControl>,
) {
    loop {
        let wanted = if stop.load(Ordering::Relaxed) {
            PollControl::Stop
        } else if pause.load(Ordering::Relaxed) {
            PollControl::Pause
        } else {
            PollControl::Run
        };
        control.send_if_modified(|current| std::mem::replace(current, wanted) != wanted);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::Protocol;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    const BURST: usize = 500;
    const ECHO_ID: u32 = 0x1ABC_DEF0;

    #[derive(Default)]
    struct Progress {
        phase: Mutex<&'static str>,
        echoed: AtomicUsize,
        generated: AtomicUsize,
    }

    impl Progress {
        fn enter(&self, phase: &'static str) {
            *self.phase.lock().unwrap() = phase;
        }

        fn count(&self, msg: SourceMessage) {
            if let SourceMessage::Frames(_, frames) = msg {
                for frame in frames {
                    let counter = if frame.is_extended && frame.frame_id == ECHO_ID {
                        &self.echoed
                    } else {
                        &self.generated
                    };
                    counter.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    fn loopback_profile() -> IOProfile {
        IOProfile {
            id: "virtual-loopback".into(),
            name: "Virtual loopback".into(),
            kind: "virtual".into(),
            connection: [(
                "interfaces".to_string(),
                serde_json::json!([{ "bus": 0, "signal_generator": true, "frame_rate_hz": 1000.0 }]),
            )]
            .into(),
            preferred_catalog: None,
            ephemeral: true,
        }
    }

    fn loopback_request(n: usize) -> TransmitRequest {
        let mut data = ECHO_ID.to_le_bytes().to_vec();
        data.extend_from_slice(&[0, 1, 0, 8]);
        data.extend_from_slice(&(n as u64).to_le_bytes());
        let (result_tx, _) = std_mpsc::sync_channel(1);
        TransmitRequest { data, frame: None, result_tx, wait_for_room: false }
    }

    async fn burst_and_stop(stop: Arc<AtomicBool>, progress: Arc<Progress>) {
        let (tx, mut rx) = mpsc::channel(1024);
        let (_cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let reader = tokio::spawn({
            let stop = stop.clone();
            async move {
                run_virtual_reader(0, &loopback_profile(), Vec::new(), stop, tx, Default::default(), Some(cmd_rx)).await
            }
        });

        progress.enter("connect");
        let transmit = loop {
            match rx.recv().await.expect("the reader announces its transmit channel") {
                SourceMessage::TransmitReady(_, transmit) => break transmit,
                msg => progress.count(msg),
            }
        };

        progress.enter("burst");
        for n in 0..BURST {
            let mut request = loopback_request(n);
            loop {
                match transmit.try_send(request) {
                    Ok(()) => break,
                    Err(std_mpsc::TrySendError::Full(back)) => {
                        request = back;
                        while let Ok(msg) = rx.try_recv() {
                            progress.count(msg);
                        }
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Err(e) => panic!("the loopback hung up: {e}"),
                }
            }
        }

        progress.enter("echo");
        while progress.echoed.load(Ordering::Relaxed) < BURST {
            progress.count(rx.recv().await.expect("the reader is running"));
        }

        progress.enter("generator");
        let target = progress.generated.load(Ordering::Relaxed) + 50;
        while progress.generated.load(Ordering::Relaxed) < target {
            progress.count(rx.recv().await.expect("the reader is running"));
        }

        progress.enter("stop");
        stop.store(true, Ordering::Relaxed);
        reader.await.expect("the reader task").expect("the reader ends cleanly");
        progress.enter("done");
    }

    #[test]
    fn a_loopback_virtual_device_keeps_its_runtime_free_under_a_transmit_burst() {
        let stop = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::default());
        let (done_tx, done_rx) = std_mpsc::channel();
        std::thread::spawn({
            let (stop, progress) = (stop.clone(), progress.clone());
            move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(burst_and_stop(stop, progress));
                let _ = done_tx.send(());
            }
        });

        // A starved runtime cannot fire its own timers, so the deadline is kept off it.
        let finished = done_rx.recv_timeout(std::time::Duration::from_secs(10));
        stop.store(true, Ordering::Relaxed);
        assert!(
            finished.is_ok(),
            "the runtime wedged in phase '{}': echoed {}/{}, generator frames {}",
            progress.phase.lock().unwrap(),
            progress.echoed.load(Ordering::Relaxed),
            BURST,
            progress.generated.load(Ordering::Relaxed),
        );
    }

    #[tokio::test]
    async fn a_serial_virtual_device_generates_bytes_not_frames() {
        let mut profile = loopback_profile();
        profile.connection.insert("traffic_type".into(), "serial".into());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = mpsc::channel(64);
        let reader = tokio::spawn({
            let stop = stop.clone();
            async move { run_virtual_reader(0, &profile, Vec::new(), stop, tx, Default::default(), None).await }
        });

        let generated = loop {
            match rx.recv().await.expect("the reader is running") {
                SourceMessage::Connected(..) | SourceMessage::TransmitReady(..) => continue,
                msg => break msg,
            }
        };
        stop.store(true, Ordering::Relaxed);
        reader.await.expect("the reader task").expect("the reader ends cleanly");

        match generated {
            SourceMessage::Bytes(0, entries) => {
                let bytes: Vec<u8> = entries.iter().map(|e| e.byte).collect();
                assert_eq!(bytes, [0, 1, 2, 3, 4, 5, 6, 7]);
            }
            SourceMessage::Frames(_, frames) => panic!("generated frames: {frames:?}"),
            _ => panic!("generated neither bytes nor frames"),
        }
    }

    #[tokio::test]
    async fn a_serial_virtual_device_echoes_the_bytes_it_is_sent() {
        let mut profile = loopback_profile();
        profile.connection.insert("traffic_type".into(), "serial".into());
        profile.connection.insert(
            "interfaces".into(),
            serde_json::json!([{ "bus": 0, "signal_generator": false, "frame_rate_hz": 1.0 }]),
        );
        let mappings = vec![BusMapping { output_bus: 3, ..Default::default() }.with_protocol(Protocol::Serial)];
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = mpsc::channel(64);
        let reader = tokio::spawn({
            let stop = stop.clone();
            async move { run_virtual_reader(0, &profile, mappings, stop, tx, Default::default(), None).await }
        });

        let echoed = loop {
            match rx.recv().await.expect("the reader is running") {
                SourceMessage::Connected(..) => continue,
                SourceMessage::TransmitReady(_, transmit) => {
                    let (result_tx, _) = std_mpsc::sync_channel(1);
                    let data = b"AT+PING\r\n".to_vec();
                    transmit.try_send(TransmitRequest { data, frame: None, result_tx, wait_for_room: false }).unwrap();
                }
                msg => break msg,
            }
        };
        stop.store(true, Ordering::Relaxed);
        reader.await.expect("the reader task").expect("the reader ends cleanly");

        match echoed {
            SourceMessage::Bytes(0, entries) => {
                let bytes: Vec<u8> = entries.iter().map(|e| e.byte).collect();
                assert_eq!(bytes, b"AT+PING\r\n");
                assert!(entries.iter().all(|e| e.bus == 3), "echoed on the output bus");
            }
            SourceMessage::Frames(_, frames) => panic!("echoed frames: {frames:?}"),
            _ => panic!("echoed neither bytes nor frames"),
        }
    }

    #[tokio::test]
    async fn a_can_virtual_device_echoes_on_its_output_bus() {
        let mut profile = loopback_profile();
        profile.connection.insert(
            "interfaces".into(),
            serde_json::json!([{ "bus": 0, "signal_generator": false, "frame_rate_hz": 1.0 }]),
        );
        let mappings = vec![BusMapping { output_bus: 3, ..Default::default() }];
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = mpsc::channel(64);
        let reader = tokio::spawn({
            let stop = stop.clone();
            async move { run_virtual_reader(0, &profile, mappings, stop, tx, Default::default(), None).await }
        });

        let echoed = loop {
            match rx.recv().await.expect("the reader is running") {
                SourceMessage::TransmitReady(_, transmit) => transmit.try_send(loopback_request(0)).unwrap(),
                SourceMessage::Frames(_, frames) => break frames,
                _ => continue,
            }
        };
        stop.store(true, Ordering::Relaxed);
        reader.await.expect("the reader task").expect("the reader ends cleanly");

        let [frame] = echoed.as_slice() else { panic!("echoed {echoed:?}") };
        assert_eq!((frame.frame_id, frame.bus), (ECHO_ID, 3), "echoed on the output bus");
    }

    #[test]
    fn a_loopback_echo_reaches_a_merge_task_on_a_multi_worker_runtime() {
        const SENDS: usize = 24;
        let (done_tx, done_rx) = std_mpsc::channel();
        let echoed = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        std::thread::spawn({
            let (echoed, accepted, stop) = (echoed.clone(), accepted.clone(), stop.clone());
            move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(4)
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async move {
                    let mut profile = loopback_profile();
                    profile.connection.insert(
                        "interfaces".into(),
                        serde_json::json!([{ "bus": 0, "signal_generator": false, "frame_rate_hz": 1.0 }]),
                    );
                    let (tx, mut rx) = mpsc::channel(1024);
                    let (transmit_tx, transmit_rx) = tokio::sync::oneshot::channel();
                    let merge = tokio::spawn({
                        let echoed = echoed.clone();
                        async move {
                            let mut transmit_tx = Some(transmit_tx);
                            while echoed.load(Ordering::Relaxed) < SENDS {
                                match rx.recv().await {
                                    Some(SourceMessage::TransmitReady(_, t)) => {
                                        let _ = transmit_tx.take().map(|slot| slot.send(t));
                                    }
                                    Some(SourceMessage::Frames(_, frames)) => {
                                        echoed.fetch_add(frames.len(), Ordering::Relaxed);
                                    }
                                    Some(_) => {}
                                    None => break,
                                }
                            }
                        }
                    });
                    let reader = tokio::spawn({
                        let stop = stop.clone();
                        async move {
                            run_virtual_reader(0, &profile, vec![BusMapping::default()], stop, tx, Default::default(), None).await
                        }
                    });
                    let transmit = transmit_rx.await.expect("the reader offers a transmit channel");
                    for n in 0..SENDS {
                        if transmit.try_send(loopback_request(n)).is_ok() {
                            accepted.fetch_add(1, Ordering::Relaxed);
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    merge.await.unwrap();
                    stop.store(true, Ordering::Relaxed);
                    let _ = reader.await;
                });
                let _ = done_tx.send(());
            }
        });

        let finished = done_rx.recv_timeout(std::time::Duration::from_secs(10));
        stop.store(true, Ordering::Relaxed);
        assert!(
            finished.is_ok(),
            "the merge task saw {}/{} echoes of {} accepted transmits",
            echoed.load(Ordering::Relaxed),
            SENDS,
            accepted.load(Ordering::Relaxed),
        );
    }
}

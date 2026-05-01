// Unified device scan module
//
// Discovers BLE devices that advertise either the WiFi provisioning GATT
// service or the SMP firmware upgrade service (or both), plus mDNS devices
// advertising _mcumgr._udp or _framelink._tcp.
//
// Emits `device-discovered` events with a `UnifiedDevice` payload that
// includes a `capabilities` list so the UI can show one device card with
// appropriate badges and route to the correct wizard flow.

use crate::ble_common;
use btleplug::api::{Central, Peripheral as _, ScanFilter};
use framelink::ble::{parse_peripheral, FRAMELINK_BLE_SERVICE_UUID};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

// ============================================================================
// Constants
// ============================================================================

/// WiFi provisioning GATT service UUID
const WIFI_PROV_SERVICE_UUID: Uuid =
    ble_common::uuid_from_fields(0x14387800, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);

/// Standard SMP GATT service UUID
const SMP_SERVICE_UUID: Uuid =
    ble_common::uuid_from_fields(0x8D53DC1D, 0x1DB7, 0x4CD3, 0x868B, 0x8A527460AA84);

/// mDNS service types to browse
const MDNS_SERVICE_MCUMGR: &str = "_mcumgr._udp.local.";
const MDNS_SERVICE_FRAMELINK: &str = "_framelink._tcp.local.";

// ============================================================================
// Types
// ============================================================================

/// A discovered device with its capabilities (which services it advertises).
#[derive(Clone, Serialize)]
pub struct UnifiedDevice {
    pub name: String,
    /// Device name with unique hardware suffix (e.g. "WiredFlexLink-9D04"),
    /// stable across BLE, mDNS, and IP changes.
    pub id: String,
    /// "ble" or "udp"
    pub transport: String,
    /// BLE peripheral ID (needed for BLE connections, absent for mDNS-only)
    pub ble_id: Option<String>,
    /// BLE only
    pub rssi: Option<i16>,
    /// mDNS only: IP address
    pub address: Option<String>,
    /// mDNS only: port number
    pub port: Option<u16>,
    /// Capabilities: "wifi-provision", "smp", "framelink"
    pub capabilities: Vec<String>,
}

// ============================================================================
// Module state
// ============================================================================

struct DeviceScanState {
    scanning: bool,
    mdns_scanning: bool,
    mdns_daemon: Option<ServiceDaemon>,
}

static SCAN_STATE: Lazy<Arc<Mutex<DeviceScanState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(DeviceScanState {
        scanning: false,
        mdns_scanning: false,
        mdns_daemon: None,
    }))
});

// ============================================================================
// Helpers
// ============================================================================

/// Get a clone of the shared BLE adapter.
async fn get_adapter() -> Result<btleplug::platform::Adapter, String> {
    let state = ble_common::BLE_ADAPTER.lock().await;
    state
        .adapter
        .clone()
        .ok_or_else(|| "BLE adapter not initialised".to_string())
}

/// Shut down the mDNS daemon if running.
async fn shutdown_mdns() {
    let mut state = SCAN_STATE.lock().await;
    state.mdns_scanning = false;
    if let Some(daemon) = state.mdns_daemon.take() {
        drop(state);
        let _ = daemon.shutdown();
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Start a unified scan for devices via BLE (checking both WiFi provisioning
/// and SMP service UUIDs) and mDNS (_mcumgr._udp, _framelink._tcp).
/// Discovered devices are emitted as `device-discovered` events.
/// The scan auto-stops after ~10 seconds or when `device_scan_stop` is called.
#[tauri::command]
pub async fn device_scan_start(app: AppHandle) -> Result<(), String> {
    ble_common::ensure_adapter().await?;

    // Shut down any previous mDNS daemon
    shutdown_mdns().await;

    let mut state = SCAN_STATE.lock().await;
    if state.scanning {
        return Ok(());
    }
    state.scanning = true;
    state.mdns_scanning = true;
    drop(state);

    let adapter = get_adapter().await?;

    // Unfiltered scan — CoreBluetooth doesn't reliably match 128-bit UUIDs
    // in scan response data, so we discover all devices and filter on the
    // application side.
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("Failed to start BLE scan: {e}"))?;

    tlog!(
        "[device_scan] Scan started (WiFi prov {:?}, SMP {:?}, FrameLink {:?})",
        WIFI_PROV_SERVICE_UUID,
        SMP_SERVICE_UUID,
        FRAMELINK_BLE_SERVICE_UUID
    );

    // -- BLE scan task --
    let app_ble = app.clone();
    tokio::spawn(async move {
        // Per-peripheral last-emitted (name, capabilities). Used to suppress
        // unchanged re-emits while still letting late-arriving advertisements
        // upgrade an existing card (e.g. MAC → "WiredFlexLink-4CD4" once the
        // SCAN_RSP / manufacturer data lands on a later poll).
        let mut last_emitted: std::collections::HashMap<String, (String, Vec<String>)> =
            std::collections::HashMap::new();

        for _ in 0..20 {
            // Poll every 500ms for 10 seconds total
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Check if scan was stopped externally
            let state = SCAN_STATE.lock().await;
            if !state.scanning {
                break;
            }
            drop(state);

            let adapter = match get_adapter().await {
                Ok(a) => a,
                Err(_) => break,
            };

            if let Ok(peripherals) = adapter.peripherals().await {
                for peripheral in peripherals {
                    let ble_id = peripheral.id().to_string();

                    let props = match peripheral.properties().await.ok().flatten() {
                        Some(p) => p,
                        None => continue,
                    };
                    let rssi = props.rssi;

                    // Decode FrameLink primary service + manufacturer-data
                    // capability bitmask. This is the canonical match for any
                    // FrameLink device — including ones whose local_name is
                    // None on Windows 11 pre-connect.
                    let parsed = parse_peripheral(ble_id.clone(), &props);
                    let mut capabilities: Vec<String> = Vec::new();

                    if let Some(d) = &parsed {
                        if let Some(p) = &d.payload {
                            let caps = p.capabilities;
                            if caps.has_wifi_prov() {
                                capabilities.push("wifi-provision".into());
                            }
                            if caps.has_smp() {
                                capabilities.push("smp".into());
                            }
                            if caps.has_framelink_ble() {
                                capabilities.push("framelink".into());
                            }
                        }
                    }

                    // UUID-only fallback: a device may advertise wifi-prov or
                    // SMP via the GATT service UUID but not be decodable by
                    // parse_peripheral (legacy firmware, non-FrameLink hosts
                    // that just expose those services).
                    let has_wifi_prov = props.services.contains(&WIFI_PROV_SERVICE_UUID)
                        || props.service_data.contains_key(&WIFI_PROV_SERVICE_UUID);
                    if has_wifi_prov && !capabilities.iter().any(|c| c == "wifi-provision") {
                        capabilities.push("wifi-provision".into());
                    }
                    let has_smp = props.services.contains(&SMP_SERVICE_UUID)
                        || props.service_data.contains_key(&SMP_SERVICE_UUID);
                    if has_smp && !capabilities.iter().any(|c| c == "smp") {
                        capabilities.push("smp".into());
                    }
                    let has_framelink_uuid = props.services.contains(&FRAMELINK_BLE_SERVICE_UUID)
                        || props
                            .service_data
                            .contains_key(&FRAMELINK_BLE_SERVICE_UUID);
                    if has_framelink_uuid && !capabilities.iter().any(|c| c == "framelink") {
                        capabilities.push("framelink".into());
                    }

                    // Drop non-FrameLink-family peripherals quietly.
                    if capabilities.is_empty() {
                        continue;
                    }

                    // Resolve a display name. Prefer the parse_peripheral
                    // name (stable, derived from manufacturer data — works on
                    // Windows 11 even when the OS doesn't surface local_name);
                    // fall back through the btleplug 0.12 advertisement_name,
                    // then post-connect local_name, then the BLE id so the
                    // card appears immediately and gets upgraded later when
                    // the full advert lands.
                    let name = parsed
                        .as_ref()
                        .map(|d| d.name.clone())
                        .or_else(|| props.advertisement_name.clone())
                        .or_else(|| props.local_name.clone())
                        .unwrap_or_else(|| ble_id.clone());

                    // Suppress unchanged re-emits; emit the first time we see
                    // a peripheral and again whenever its name or capability
                    // set changes (so the frontend's addDevice merge replaces
                    // a MAC-only placeholder with the real name).
                    match last_emitted.get(&ble_id) {
                        Some((prev_name, prev_caps))
                            if prev_name == &name && prev_caps == &capabilities =>
                        {
                            continue;
                        }
                        _ => {}
                    }
                    last_emitted.insert(ble_id.clone(), (name.clone(), capabilities.clone()));

                    // id is keyed off the BLE peripheral id (MAC on Windows /
                    // Linux, opaque UUID on macOS) so it stays stable across
                    // re-emits as the name/caps progressively resolve.
                    let id = format!("ble:{}", ble_id);

                    tlog!(
                        "[device_scan] BLE matched: {} (ble_id={}, parsed={}, adv_name={:?}, local_name={:?}), RSSI: {:?}, caps: {:?}",
                        name,
                        ble_id,
                        parsed.is_some(),
                        props.advertisement_name,
                        props.local_name,
                        rssi,
                        capabilities
                    );

                    let device = UnifiedDevice {
                        name,
                        id,
                        transport: "ble".to_string(),
                        ble_id: Some(ble_id),
                        rssi,
                        address: None,
                        port: None,
                        capabilities,
                    };
                    let _ = app_ble.emit("device-discovered", &device);
                }
            }
        }

        // Auto-stop scan after timeout
        let mut state = SCAN_STATE.lock().await;
        if state.scanning {
            state.scanning = false;
            drop(state);
            if let Ok(adapter) = get_adapter().await {
                let _ = adapter.stop_scan().await;
            }
        } else {
            drop(state);
        }
        tlog!("[device_scan] BLE scan finished");
        let _ = app_ble.emit("device-scan-finished", ());
    });

    // -- mDNS browse task --
    tokio::spawn(async move {
        tlog!("[device_scan] Creating mDNS daemon...");
        let daemon = match ServiceDaemon::new() {
            Ok(d) => {
                tlog!("[device_scan] mDNS daemon created successfully");
                d
            }
            Err(e) => {
                tlog!("[device_scan] Failed to create mDNS daemon: {e}");
                return;
            }
        };

        // Store daemon in state for later shutdown
        {
            let mut state = SCAN_STATE.lock().await;
            state.mdns_daemon = Some(daemon.clone());
        }

        let receiver_mcumgr = match daemon.browse(MDNS_SERVICE_MCUMGR) {
            Ok(r) => r,
            Err(e) => {
                tlog!("[device_scan] Failed to browse {MDNS_SERVICE_MCUMGR}: {e}");
                return;
            }
        };

        let receiver_framelink = match daemon.browse(MDNS_SERVICE_FRAMELINK) {
            Ok(r) => r,
            Err(e) => {
                tlog!("[device_scan] Failed to browse {MDNS_SERVICE_FRAMELINK}: {e}");
                return;
            }
        };

        tlog!(
            "[device_scan] mDNS browse started for {} and {}",
            MDNS_SERVICE_MCUMGR,
            MDNS_SERVICE_FRAMELINK
        );

        // Spawn a blocking receiver task per service type — each service
        // becomes its own device card (no cross-service merging).
        let spawn_mdns_receiver = |rx: mdns_sd::Receiver<ServiceEvent>,
                                    svc: &'static str,
                                    app_handle: AppHandle| {
            tokio::task::spawn_blocking(move || {
                let poll_interval = std::time::Duration::from_millis(250);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                let mut event_count = 0u32;
                let mut seen = HashSet::<String>::new();

                let (cap, transport) = if svc == MDNS_SERVICE_FRAMELINK {
                    ("framelink", "tcp")
                } else {
                    ("smp", "udp")
                };

                while std::time::Instant::now() < deadline {
                    while let Ok(event) = rx.try_recv() {
                        event_count += 1;
                        if let ServiceEvent::ServiceResolved(info) = &event {
                            tlog!(
                                "[device_scan] mDNS ServiceResolved: {} addrs={:?} port={}",
                                info.get_fullname(),
                                info.get_addresses(),
                                info.get_port()
                            );
                            for addr in info.get_addresses() {
                                let port = info.get_port();

                                let name = info
                                    .get_fullname()
                                    .split('.')
                                    .next()
                                    .unwrap_or("Unknown")
                                    .to_string();

                                let id = format!("{}:{}", transport, name);
                                if seen.contains(&id) {
                                    continue;
                                }
                                seen.insert(id.clone());

                                tlog!(
                                    "[device_scan] mDNS emitting device: {} at {}:{} ({}, cap={})",
                                    name,
                                    addr,
                                    port,
                                    svc,
                                    cap
                                );

                                // Reaching us via mDNS implies the device is
                                // already provisioned onto the network, so
                                // the wifi chip lights up on every mDNS card
                                // alongside the service-specific capability.
                                let device = UnifiedDevice {
                                    name,
                                    id,
                                    transport: transport.to_string(),
                                    ble_id: None,
                                    rssi: None,
                                    address: Some(addr.to_string()),
                                    port: Some(port),
                                    capabilities: vec![
                                        "wifi-provision".to_string(),
                                        cap.to_string(),
                                    ],
                                };
                                let _ = app_handle.emit("device-discovered", &device);
                            }
                        }
                    }

                    std::thread::sleep(poll_interval);
                }

                tlog!(
                    "[device_scan] mDNS receiver for {} finished after {} events",
                    svc,
                    event_count
                );
            })
        };

        let h1 = spawn_mdns_receiver(
            receiver_mcumgr,
            MDNS_SERVICE_MCUMGR,
            app.clone(),
        );
        let h2 = spawn_mdns_receiver(
            receiver_framelink,
            MDNS_SERVICE_FRAMELINK,
            app.clone(),
        );

        // Wait for both receiver tasks to finish
        let _ = h1.await;
        let _ = h2.await;

        // Clean up mDNS
        shutdown_mdns().await;
        tlog!("[device_scan] mDNS browse finished");
    });

    Ok(())
}

/// Stop an active unified scan (both BLE and mDNS).
#[tauri::command]
pub async fn device_scan_stop(_app: AppHandle) -> Result<(), String> {
    let mut state = SCAN_STATE.lock().await;
    if !state.scanning && !state.mdns_scanning {
        return Ok(());
    }
    state.scanning = false;
    state.mdns_scanning = false;
    drop(state);

    if let Ok(adapter) = get_adapter().await {
        adapter
            .stop_scan()
            .await
            .map_err(|e| format!("Failed to stop BLE scan: {e}"))?;
    }

    shutdown_mdns().await;

    Ok(())
}

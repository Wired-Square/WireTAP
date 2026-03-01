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
    /// BLE: peripheral ID string, UDP: "udp:address:port"
    pub id: String,
    /// "ble" or "udp"
    pub transport: String,
    /// BLE only
    pub rssi: Option<i16>,
    /// UDP only: IP address
    pub address: Option<String>,
    /// UDP only: port number
    pub port: Option<u16>,
    /// Capabilities: "wifi-provision", "smp"
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
        "[device_scan] Scan started (WiFi prov UUID {:?}, SMP UUID {:?})",
        WIFI_PROV_SERVICE_UUID,
        SMP_SERVICE_UUID
    );

    // -- BLE scan task --
    let app_ble = app.clone();
    tokio::spawn(async move {
        let mut seen_ids = HashSet::new();

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
                    let id = peripheral.id().to_string();
                    if seen_ids.contains(&id) {
                        continue;
                    }

                    let props = match peripheral.properties().await.ok().flatten() {
                        Some(p) => p,
                        None => continue,
                    };

                    let name = props.local_name.clone().unwrap_or_else(|| id.clone());
                    let rssi = props.rssi;

                    // Build capabilities list from advertised services
                    let mut capabilities = Vec::new();

                    let has_wifi_prov = props.services.contains(&WIFI_PROV_SERVICE_UUID)
                        || props.service_data.contains_key(&WIFI_PROV_SERVICE_UUID);
                    if has_wifi_prov {
                        capabilities.push("wifi-provision".to_string());
                    }

                    let has_smp = props.services.contains(&SMP_SERVICE_UUID)
                        || props.service_data.contains_key(&SMP_SERVICE_UUID);
                    if has_smp {
                        capabilities.push("smp".to_string());
                    }

                    // Skip devices that don't advertise either service
                    if capabilities.is_empty() {
                        continue;
                    }

                    seen_ids.insert(id.clone());

                    tlog!(
                        "[device_scan] BLE matched: {} ({}), RSSI: {:?}, caps: {:?}",
                        name,
                        id,
                        rssi,
                        capabilities
                    );

                    let device = UnifiedDevice {
                        name,
                        id,
                        transport: "ble".to_string(),
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

        // Shared seen-IDs set for deduplication across both service browsers
        let seen_udp_ids = Arc::new(std::sync::Mutex::new(HashSet::<String>::new()));

        // Spawn a blocking receiver task per service type
        let spawn_mdns_receiver = |rx: mdns_sd::Receiver<ServiceEvent>,
                                    svc: &'static str,
                                    app_handle: AppHandle,
                                    seen: Arc<std::sync::Mutex<HashSet<String>>>| {
            tokio::task::spawn_blocking(move || {
                let poll_interval = std::time::Duration::from_millis(250);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                let mut event_count = 0u32;

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
                                let id = format!("udp:{}:{}", addr, port);

                                let mut seen_guard = seen.lock().unwrap();
                                if seen_guard.contains(&id) {
                                    continue;
                                }
                                seen_guard.insert(id.clone());
                                drop(seen_guard);

                                let name = info
                                    .get_fullname()
                                    .split('.')
                                    .next()
                                    .unwrap_or("Unknown")
                                    .to_string();

                                tlog!(
                                    "[device_scan] mDNS emitting device: {} at {}:{} ({})",
                                    name,
                                    addr,
                                    port,
                                    svc
                                );

                                // UDP/mDNS devices get "smp" capability
                                let device = UnifiedDevice {
                                    name,
                                    id,
                                    transport: "udp".to_string(),
                                    rssi: None,
                                    address: Some(addr.to_string()),
                                    port: Some(port),
                                    capabilities: vec!["smp".to_string()],
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
            seen_udp_ids.clone(),
        );
        let h2 = spawn_mdns_receiver(
            receiver_framelink,
            MDNS_SERVICE_FRAMELINK,
            app.clone(),
            seen_udp_ids,
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

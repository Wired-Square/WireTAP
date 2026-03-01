// SMP Firmware Upgrade module
//
// Uses the MCUmgr SMP protocol to perform firmware upgrades on Zephyr
// devices over BLE and UDP. Communicates via the standard SMP GATT
// service (BLE) or SMP UDP port (network).
//
// SMP Service UUID: 8D53DC1D-1DB7-4CD3-868B-8A527460AA84
// mDNS services:    _mcumgr._udp, _framelink._tcp

use crate::ble_common;
use btleplug::api::{Central, Peripheral as _, ScanFilter};
use btleplug::platform::Peripheral;
use mcumgr_smp::application_management;
use mcumgr_smp::os_management;
use mcumgr_smp::smp::SmpFrame;
use async_trait::async_trait;
use mcumgr_smp::transport::ble::BleTransport;
use mcumgr_smp::transport::error::Error as SmpError;
use mcumgr_smp::transport::smp::SmpTransportAsync;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use once_cell::sync::Lazy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use uuid::Uuid;

// ============================================================================
// Constants
// ============================================================================

/// Standard SMP GATT service UUID
const SMP_SERVICE_UUID: Uuid =
    ble_common::uuid_from_fields(0x8D53DC1D, 0x1DB7, 0x4CD3, 0x868B, 0x8A527460AA84);

/// Chunk size for BLE firmware upload (bytes).
/// 500 bytes is safely below the 512-byte SMP MTU (8-byte SMP header + payload).
const BLE_CHUNK_SIZE: usize = 500;

/// Chunk size for UDP firmware upload (bytes).
const UDP_CHUNK_SIZE: usize = 1024;

/// mDNS service types to browse
const MDNS_SERVICE_MCUMGR: &str = "_mcumgr._udp.local.";
const MDNS_SERVICE_FRAMELINK: &str = "_framelink._tcp.local.";

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Serialize)]
pub struct ImageSlotInfo {
    pub slot: i32,
    pub version: String,
    pub hash: String,
    pub bootable: bool,
    pub pending: bool,
    pub confirmed: bool,
    pub active: bool,
    pub permanent: bool,
    pub image: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct UploadProgress {
    pub bytes_sent: usize,
    pub total_bytes: usize,
    pub percent: f32,
}

/// Unified device type for both BLE and mDNS-discovered devices.
#[derive(Clone, Serialize)]
pub struct DiscoveredDevice {
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
    /// mDNS service type (e.g. "_mcumgr._udp")
    pub service_type: Option<String>,
}

// ============================================================================
// Connection enum
// ============================================================================

enum SmpConnection {
    Ble(Peripheral),
    Udp(SocketAddr),
}

// ============================================================================
// Custom UDP transport (IPv4/IPv6 compatible)
// ============================================================================

/// Custom SMP UDP transport that correctly handles both IPv4 and IPv6.
/// The upstream UdpTransportAsync always binds to [::] which fails on
/// macOS when connecting to IPv4 addresses (IPV6_V6ONLY is set).
struct SmpUdpTransport {
    socket: UdpSocket,
    buf: Vec<u8>,
}

impl SmpUdpTransport {
    async fn new(addr: SocketAddr) -> Result<Self, std::io::Error> {
        // Bind to the matching IP version
        let bind_addr = match addr {
            SocketAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
            SocketAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
        };
        let socket = UdpSocket::bind(bind_addr).await?;
        socket.connect(addr).await?;
        Ok(Self {
            socket,
            buf: vec![0; 1500],
        })
    }
}

#[async_trait]
impl SmpTransportAsync for SmpUdpTransport {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), SmpError> {
        self.socket.send(&frame).await?;
        Ok(())
    }

    async fn receive(&mut self) -> Result<Vec<u8>, SmpError> {
        let len = self.socket.recv(&mut self.buf).await?;
        Ok(Vec::from(&self.buf[..len]))
    }
}

// ============================================================================
// Module state
// ============================================================================

struct SmpUpgradeState {
    connection: Option<SmpConnection>,
    scanning: bool,
    mdns_scanning: bool,
    mdns_daemon: Option<ServiceDaemon>,
    cancel_upload: Arc<AtomicBool>,
    seq: u8,
}

static SMP_STATE: Lazy<Arc<Mutex<SmpUpgradeState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(SmpUpgradeState {
        connection: None,
        scanning: false,
        mdns_scanning: false,
        mdns_daemon: None,
        cancel_upload: Arc::new(AtomicBool::new(false)),
        seq: 0,
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

/// Get the next sequence number (wrapping u8).
async fn next_seq() -> u8 {
    let mut state = SMP_STATE.lock().await;
    let seq = state.seq;
    state.seq = seq.wrapping_add(1);
    seq
}

/// Create an SMP transport from the currently stored connection.
async fn create_transport() -> Result<Box<dyn SmpTransportAsync + Send>, String> {
    let state = SMP_STATE.lock().await;
    match &state.connection {
        Some(SmpConnection::Ble(peripheral)) => {
            let peripheral = peripheral.clone();
            drop(state);
            let transport = BleTransport::from_peripheral(peripheral)
                .await
                .map_err(|e| format!("Failed to create BLE transport: {e}"))?;
            Ok(Box::new(transport))
        }
        Some(SmpConnection::Udp(addr)) => {
            let addr = *addr;
            drop(state);
            let transport = SmpUdpTransport::new(addr)
                .await
                .map_err(|e| format!("Failed to create UDP transport: {e}"))?;
            Ok(Box::new(transport))
        }
        None => Err("Not connected to a device".to_string()),
    }
}

/// Get the chunk size for the current connection type.
async fn get_chunk_size() -> usize {
    let state = SMP_STATE.lock().await;
    match &state.connection {
        Some(SmpConnection::Udp(_)) => UDP_CHUNK_SIZE,
        _ => BLE_CHUNK_SIZE,
    }
}

/// Shut down the mDNS daemon if running.
async fn shutdown_mdns() {
    let mut state = SMP_STATE.lock().await;
    state.mdns_scanning = false;
    if let Some(daemon) = state.mdns_daemon.take() {
        drop(state);
        let _ = daemon.shutdown();
    }
}

// ============================================================================
// Tauri commands -- Scanning
// ============================================================================

/// Start scanning for devices via BLE and mDNS.
/// Discovered devices are emitted as `smp-device-discovered` events.
/// The scan auto-stops after ~10 seconds or when `smp_scan_stop` is called.
#[tauri::command]
pub async fn smp_scan_start(app: AppHandle) -> Result<(), String> {
    ble_common::ensure_adapter().await?;

    // Shut down any previous mDNS daemon
    shutdown_mdns().await;

    let mut state = SMP_STATE.lock().await;
    if state.scanning {
        return Ok(());
    }
    state.scanning = true;
    state.mdns_scanning = true;
    drop(state);

    let adapter = get_adapter().await?;

    // Unfiltered scan -- same rationale as ble_provision (CoreBluetooth
    // doesn't reliably match 128-bit UUIDs in scan response data)
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("Failed to start BLE scan: {e}"))?;

    tlog!(
        "[smp_upgrade] Scan started (filtering for SMP UUID {:?})",
        SMP_SERVICE_UUID
    );

    // -- BLE scan task --
    let app_ble = app.clone();
    tokio::spawn(async move {
        let mut seen_ids = HashSet::new();

        for _ in 0..20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Check if scan was stopped externally
            let state = SMP_STATE.lock().await;
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

                    // Match devices that advertise the SMP service UUID
                    let advertises_service = props.services.contains(&SMP_SERVICE_UUID)
                        || props.service_data.contains_key(&SMP_SERVICE_UUID);
                    if !advertises_service {
                        continue;
                    }

                    seen_ids.insert(id.clone());

                    tlog!(
                        "[smp_upgrade] BLE matched: {} ({}), RSSI: {:?}",
                        name,
                        id,
                        rssi
                    );

                    let device = DiscoveredDevice {
                        name,
                        id,
                        transport: "ble".to_string(),
                        rssi,
                        address: None,
                        port: None,
                        service_type: None,
                    };
                    let _ = app_ble.emit("smp-device-discovered", &device);
                }
            }
        }

        // Auto-stop scan after timeout
        let mut state = SMP_STATE.lock().await;
        if state.scanning {
            state.scanning = false;
            drop(state);
            if let Ok(adapter) = get_adapter().await {
                let _ = adapter.stop_scan().await;
            }
        } else {
            drop(state);
        }
        tlog!("[smp_upgrade] BLE scan finished");
        let _ = app_ble.emit("smp-scan-finished", ());
    });

    // -- mDNS browse task --
    tokio::spawn(async move {
        tlog!("[smp_upgrade] Creating mDNS daemon...");
        let daemon = match ServiceDaemon::new() {
            Ok(d) => {
                tlog!("[smp_upgrade] mDNS daemon created successfully");
                d
            }
            Err(e) => {
                tlog!("[smp_upgrade] Failed to create mDNS daemon: {e}");
                return;
            }
        };

        // Store daemon in state for later shutdown
        {
            let mut state = SMP_STATE.lock().await;
            state.mdns_daemon = Some(daemon.clone());
        }

        let receiver_mcumgr = match daemon.browse(MDNS_SERVICE_MCUMGR) {
            Ok(r) => r,
            Err(e) => {
                tlog!("[smp_upgrade] Failed to browse {MDNS_SERVICE_MCUMGR}: {e}");
                return;
            }
        };

        let receiver_framelink = match daemon.browse(MDNS_SERVICE_FRAMELINK) {
            Ok(r) => r,
            Err(e) => {
                tlog!("[smp_upgrade] Failed to browse {MDNS_SERVICE_FRAMELINK}: {e}");
                return;
            }
        };

        tlog!("[smp_upgrade] mDNS browse started for {MDNS_SERVICE_MCUMGR} and {MDNS_SERVICE_FRAMELINK}");

        // Shared seen-IDs set for deduplication across both service browsers
        let seen_udp_ids = Arc::new(std::sync::Mutex::new(HashSet::<String>::new()));

        // Spawn a blocking receiver task per service type so events
        // are never lost through select-race conditions.
        let spawn_mdns_receiver =
            |rx: mdns_sd::Receiver<ServiceEvent>,
             svc: &'static str,
             app_handle: AppHandle,
             seen: Arc<std::sync::Mutex<HashSet<String>>>| {
                tokio::task::spawn_blocking(move || {
                    let poll_interval = std::time::Duration::from_millis(250);
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_secs(15);
                    let mut event_count = 0u32;

                    while std::time::Instant::now() < deadline {
                        // Drain all pending events without blocking
                        while let Ok(event) = rx.try_recv() {
                            event_count += 1;
                            match &event {
                                ServiceEvent::SearchStarted(svc_type) => {
                                    tlog!("[smp_upgrade] mDNS SearchStarted: {}", svc_type);
                                }
                                ServiceEvent::ServiceFound(svc_type, fullname) => {
                                    tlog!(
                                        "[smp_upgrade] mDNS ServiceFound: {} ({})",
                                        fullname,
                                        svc_type
                                    );
                                }
                                ServiceEvent::ServiceResolved(info) => {
                                    tlog!(
                                        "[smp_upgrade] mDNS ServiceResolved: {} addrs={:?} port={}",
                                        info.get_fullname(),
                                        info.get_addresses(),
                                        info.get_port()
                                    );
                                    for addr in info.get_addresses() {
                                        let port = info.get_port();
                                        let id = format!("udp:{}:{}", addr, port);

                                        let mut seen_guard = seen.lock().unwrap();
                                        if seen_guard.contains(&id) {
                                            tlog!("[smp_upgrade] mDNS skipping duplicate: {}", id);
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

                                        let svc_display =
                                            svc.trim_end_matches(".local.").to_string();

                                        tlog!(
                                            "[smp_upgrade] mDNS emitting device: {} at {}:{} ({})",
                                            name,
                                            addr,
                                            port,
                                            svc_display
                                        );

                                        let device = DiscoveredDevice {
                                            name,
                                            id,
                                            transport: "udp".to_string(),
                                            rssi: None,
                                            address: Some(addr.to_string()),
                                            port: Some(port),
                                            service_type: Some(svc_display),
                                        };
                                        let _ =
                                            app_handle.emit("smp-device-discovered", &device);
                                    }
                                }
                                ServiceEvent::ServiceRemoved(svc_type, fullname) => {
                                    tlog!(
                                        "[smp_upgrade] mDNS ServiceRemoved: {} ({})",
                                        fullname,
                                        svc_type
                                    );
                                }
                                ServiceEvent::SearchStopped(svc_type) => {
                                    tlog!("[smp_upgrade] mDNS SearchStopped: {}", svc_type);
                                }
                            }
                        }

                        // Sleep before next poll
                        std::thread::sleep(poll_interval);
                    }

                    tlog!(
                        "[smp_upgrade] mDNS receiver for {} finished after {} events",
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
        tlog!("[smp_upgrade] mDNS browse finished");
    });

    Ok(())
}

/// Stop an active scan (both BLE and mDNS).
#[tauri::command]
pub async fn smp_scan_stop(_app: AppHandle) -> Result<(), String> {
    let mut state = SMP_STATE.lock().await;
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

    // Shut down mDNS daemon
    shutdown_mdns().await;

    Ok(())
}

// ============================================================================
// Tauri commands -- Connection
// ============================================================================

/// Attach to the already-connected provisioning BLE peripheral for SMP.
///
/// Instead of looking up the peripheral via the adapter and reconnecting,
/// this reuses the peripheral reference held by `ble_provision`. This avoids
/// adapter cache issues and BLE channel conflicts when both provisioning and
/// SMP are used on the same device simultaneously.
#[tauri::command]
pub async fn smp_attach_ble(app: AppHandle) -> Result<(), String> {
    let peripheral = crate::ble_provision::get_connected_peripheral()
        .await
        .ok_or("No provisioning BLE connection active")?;

    let device_id = peripheral.id().to_string();

    // Discover services if they haven't been discovered for SMP yet
    let has_smp = peripheral.services().iter().any(|s| s.uuid == SMP_SERVICE_UUID);
    if !has_smp {
        peripheral
            .discover_services()
            .await
            .map_err(|e| format!("Failed to discover services: {e}"))?;

        let has_smp = peripheral.services().iter().any(|s| s.uuid == SMP_SERVICE_UUID);
        if !has_smp {
            return Err("Device does not have the SMP service".to_string());
        }
    }

    tlog!("[smp_upgrade] Attached to provisioning peripheral {device_id} for SMP");

    let mut state = SMP_STATE.lock().await;
    state.connection = Some(SmpConnection::Ble(peripheral.clone()));
    drop(state);

    // Spawn disconnect watchdog (same as smp_connect_ble)
    let app_clone = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            let state = SMP_STATE.lock().await;
            let is_current = match &state.connection {
                Some(SmpConnection::Ble(p)) => p.id() == peripheral.id(),
                _ => false,
            };
            drop(state);

            if !is_current {
                break;
            }

            let connected = peripheral.is_connected().await.unwrap_or(false);
            if !connected {
                tlog!("[smp_upgrade] Watchdog: attached peripheral {device_id} disconnected");
                // Only emit disconnect if this peripheral is still the active
                // connection — a UDP or different BLE connection may have replaced
                // it in the meantime.
                let mut state = SMP_STATE.lock().await;
                let was_current =
                    if let Some(SmpConnection::Ble(ref p)) = state.connection {
                        if p.id() == peripheral.id() {
                            state.connection = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                drop(state);
                if was_current {
                    let _ = app_clone.emit("smp-device-disconnected", &device_id);
                }
                break;
            }
        }
    });

    Ok(())
}

/// Connect to a BLE peripheral by its platform-specific ID string.
/// Discovers services and verifies the SMP service is present.
#[tauri::command]
pub async fn smp_connect_ble(app: AppHandle, device_id: String) -> Result<(), String> {
    ble_common::ensure_adapter().await?;

    // Disconnect any existing connection first
    {
        let mut state = SMP_STATE.lock().await;
        if let Some(SmpConnection::Ble(old)) = state.connection.take() {
            let _ = old.disconnect().await;
            tlog!("[smp_upgrade] Disconnected previous BLE peripheral before new connect");
        } else {
            state.connection = None;
        }
    }

    let adapter = get_adapter().await?;

    // Try to find the peripheral in the adapter cache first
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("Failed to list peripherals: {e}"))?;

    let peripheral = match peripherals
        .into_iter()
        .find(|p| p.id().to_string() == device_id)
    {
        Some(p) => p,
        None => {
            // Device not in adapter cache (e.g. evicted by CoreBluetooth after
            // a previous disconnect). Run a quick scan to rediscover it.
            tlog!(
                "[smp_upgrade] Device {} not in cache, running quick rescan...",
                device_id
            );
            let _ = adapter.start_scan(ScanFilter::default()).await;
            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            let _ = adapter.stop_scan().await;

            let peripherals = adapter
                .peripherals()
                .await
                .map_err(|e| format!("Failed to list peripherals after rescan: {e}"))?;

            peripherals
                .into_iter()
                .find(|p| p.id().to_string() == device_id)
                .ok_or_else(|| format!("Device '{}' not found after rescan", device_id))?
        }
    };

    tlog!("[smp_upgrade] Connecting to {device_id}...");
    match tokio::time::timeout(
        tokio::time::Duration::from_secs(15),
        peripheral.connect(),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(format!("Failed to connect: {e}")),
        Err(_) => {
            // Timeout — attempt to clean up
            let _ = peripheral.disconnect().await;
            return Err("Connection timed out after 15 seconds".to_string());
        }
    }

    match tokio::time::timeout(
        tokio::time::Duration::from_secs(10),
        peripheral.discover_services(),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let p = peripheral.clone();
            tokio::spawn(async move {
                let _ = p.disconnect().await;
            });
            return Err(format!("Failed to discover services: {e}"));
        }
        Err(_) => {
            let _ = peripheral.disconnect().await;
            return Err("Service discovery timed out after 10 seconds".to_string());
        }
    }

    // Verify the SMP service is present
    let has_service = peripheral.services().iter().any(|s| s.uuid == SMP_SERVICE_UUID);
    if !has_service {
        let _ = peripheral.disconnect().await;
        return Err("Device does not have the SMP service".to_string());
    }

    tlog!("[smp_upgrade] Connected to {device_id}");

    let mut state = SMP_STATE.lock().await;
    state.connection = Some(SmpConnection::Ble(peripheral.clone()));
    drop(state);

    // Spawn disconnect watchdog
    let app_clone = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            let state = SMP_STATE.lock().await;
            let is_current = match &state.connection {
                Some(SmpConnection::Ble(p)) => p.id() == peripheral.id(),
                _ => false,
            };
            drop(state);

            if !is_current {
                break;
            }

            let connected = peripheral.is_connected().await.unwrap_or(false);
            if !connected {
                tlog!(
                    "[smp_upgrade] Watchdog: peripheral {device_id} disconnected unexpectedly"
                );
                // Only emit disconnect if this peripheral is still the active
                // connection — a UDP or different BLE connection may have replaced
                // it in the meantime.
                let mut state = SMP_STATE.lock().await;
                let was_current =
                    if let Some(SmpConnection::Ble(ref p)) = state.connection {
                        if p.id() == peripheral.id() {
                            state.connection = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                drop(state);
                if was_current {
                    let _ = app_clone.emit("smp-device-disconnected", &device_id);
                }
                break;
            }
        }
    });

    Ok(())
}

/// Connect to a device via UDP transport.
#[tauri::command]
pub async fn smp_connect_udp(address: String, port: u16) -> Result<(), String> {
    let addr: SocketAddr = format!("{}:{}", address, port)
        .parse()
        .map_err(|e| format!("Invalid address: {e}"))?;

    // Disconnect any existing connection first
    {
        let mut state = SMP_STATE.lock().await;
        if let Some(SmpConnection::Ble(old)) = state.connection.take() {
            let _ = old.disconnect().await;
            tlog!("[smp_upgrade] Disconnected BLE peripheral before UDP connect");
        } else {
            state.connection = None;
        }
    }

    // Verify we can create a UDP transport (validates socket creation)
    let _transport = SmpUdpTransport::new(addr)
        .await
        .map_err(|e| format!("Failed to create UDP transport to {addr}: {e}"))?;

    tlog!("[smp_upgrade] UDP connected to {addr}");

    let mut state = SMP_STATE.lock().await;
    state.connection = Some(SmpConnection::Udp(addr));

    Ok(())
}

/// Disconnect from the currently connected device.
#[tauri::command]
pub async fn smp_disconnect() -> Result<(), String> {
    let mut state = SMP_STATE.lock().await;
    match state.connection.take() {
        Some(SmpConnection::Ble(peripheral)) => {
            tlog!("[smp_upgrade] Disconnecting BLE {:?}", peripheral.id());
            let _ = peripheral.disconnect().await;
        }
        Some(SmpConnection::Udp(addr)) => {
            tlog!("[smp_upgrade] Disconnecting UDP {addr} (no-op)");
            // UDP is connectionless, nothing to do
        }
        None => {}
    }
    Ok(())
}

// ============================================================================
// Tauri commands -- Image management
// ============================================================================

/// List firmware images in all slots on the connected device.
#[tauri::command]
pub async fn smp_list_images() -> Result<Vec<ImageSlotInfo>, String> {
    let mut transport = create_transport().await?;
    let seq = next_seq().await;

    let frame = application_management::get_state(seq);
    let encoded = frame.encode_with_cbor();

    transport
        .send(encoded)
        .await
        .map_err(|e| format!("Failed to send get_state: {e}"))?;

    let response = transport
        .receive()
        .await
        .map_err(|e| format!("Failed to receive get_state response: {e}"))?;

    let result_frame: SmpFrame<application_management::GetImageStateResult> =
        SmpFrame::decode_with_cbor(&response)
            .map_err(|e| format!("Failed to decode get_state response: {e}"))?;

    let images = match result_frame.data {
        application_management::GetImageStateResult::Ok(payload) => payload
            .images
            .into_iter()
            .map(|img| ImageSlotInfo {
                slot: img.slot,
                version: img.version,
                hash: hex::encode(&img.hash),
                bootable: img.bootable,
                pending: img.pending,
                confirmed: img.confirmed,
                active: img.active,
                permanent: img.permanent,
                image: img.image,
            })
            .collect(),
        application_management::GetImageStateResult::Err(e) => {
            return Err(format!(
                "Device returned error rc={}, reason={:?}",
                e.rc, e.rsn
            ));
        }
    };

    Ok(images)
}

/// Upload a firmware binary to the device.
/// Emits `smp-upload-progress` events during the transfer and
/// `smp-upload-complete` when finished.
#[tauri::command]
pub async fn smp_upload_firmware(
    app: AppHandle,
    file_path: String,
    image: Option<u8>,
) -> Result<(), String> {
    // Read the firmware file
    let data = std::fs::read(&file_path).map_err(|e| format!("Failed to read firmware file: {e}"))?;
    let total_bytes = data.len();

    tlog!(
        "[smp_upgrade] Starting firmware upload: {} ({} bytes)",
        file_path,
        total_bytes
    );

    // Compute SHA-256 hash
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let hash = hasher.finalize().to_vec();

    // Reset cancel flag
    let cancel_flag = {
        let state = SMP_STATE.lock().await;
        state.cancel_upload.store(false, Ordering::Relaxed);
        state.cancel_upload.clone()
    };

    let chunk_size = get_chunk_size().await;
    let mut transport = create_transport().await?;

    // Create image writer
    let mut writer =
        application_management::ImageWriter::new(image, total_bytes, Some(&hash), false);

    // Chunk upload loop
    let mut offset = 0;
    while offset < total_bytes {
        // Check for cancellation
        if cancel_flag.load(Ordering::Relaxed) {
            tlog!("[smp_upgrade] Upload cancelled by user");
            return Err("Upload cancelled".to_string());
        }

        let end = std::cmp::min(offset + chunk_size, total_bytes);
        let chunk = &data[offset..end];

        let frame = writer.write_chunk(chunk);
        let encoded = frame.encode_with_cbor();

        transport
            .send(encoded)
            .await
            .map_err(|e| format!("Failed to send upload chunk at offset {offset}: {e}"))?;

        let response = transport
            .receive()
            .await
            .map_err(|e| format!("Failed to receive upload response at offset {offset}: {e}"))?;

        // Decode response to check for errors
        let result_frame: SmpFrame<application_management::WriteImageChunkResult> =
            SmpFrame::decode_with_cbor(&response)
                .map_err(|e| format!("Failed to decode upload response: {e}"))?;

        match result_frame.data {
            application_management::WriteImageChunkResult::Ok(_) => {}
            application_management::WriteImageChunkResult::Err(e) => {
                return Err(format!(
                    "Device rejected upload at offset {offset}, rc={}, reason={:?}",
                    e.rc, e.rsn
                ));
            }
        }

        offset = end;

        // Emit progress
        let progress = UploadProgress {
            bytes_sent: offset,
            total_bytes,
            percent: (offset as f32 / total_bytes as f32) * 100.0,
        };
        let _ = app.emit("smp-upload-progress", &progress);
    }

    tlog!("[smp_upgrade] Upload complete ({} bytes)", total_bytes);
    let _ = app.emit("smp-upload-complete", ());

    Ok(())
}

/// Mark a firmware image for test boot (will revert on next reboot if not confirmed).
#[tauri::command]
pub async fn smp_test_image(hash: Vec<u8>) -> Result<(), String> {
    let mut transport = create_transport().await?;
    let seq = next_seq().await;

    let frame = application_management::set_state(hash, false, seq);
    let encoded = frame.encode_with_cbor();

    transport
        .send(encoded)
        .await
        .map_err(|e| format!("Failed to send test_image: {e}"))?;

    let response = transport
        .receive()
        .await
        .map_err(|e| format!("Failed to receive test_image response: {e}"))?;

    let _result_frame: SmpFrame<application_management::GetImageStateResult> =
        SmpFrame::decode_with_cbor(&response)
            .map_err(|e| format!("Failed to decode test_image response: {e}"))?;

    tlog!("[smp_upgrade] Image marked for test boot");
    Ok(())
}

/// Permanently confirm a firmware image (prevents rollback).
#[tauri::command]
pub async fn smp_confirm_image(hash: Vec<u8>) -> Result<(), String> {
    let mut transport = create_transport().await?;
    let seq = next_seq().await;

    let frame = application_management::set_state(hash, true, seq);
    let encoded = frame.encode_with_cbor();

    transport
        .send(encoded)
        .await
        .map_err(|e| format!("Failed to send confirm_image: {e}"))?;

    let response = transport
        .receive()
        .await
        .map_err(|e| format!("Failed to receive confirm_image response: {e}"))?;

    let _result_frame: SmpFrame<application_management::GetImageStateResult> =
        SmpFrame::decode_with_cbor(&response)
            .map_err(|e| format!("Failed to decode confirm_image response: {e}"))?;

    tlog!("[smp_upgrade] Image confirmed");
    Ok(())
}

/// Reset the device (reboot into new firmware after test/confirm).
#[tauri::command]
pub async fn smp_reset_device() -> Result<(), String> {
    let mut transport = create_transport().await?;
    let seq = next_seq().await;

    let frame = os_management::reset(seq, false);
    let encoded = frame.encode_with_cbor();

    transport
        .send(encoded)
        .await
        .map_err(|e| format!("Failed to send reset: {e}"))?;

    // The device may disconnect before sending a response, so
    // we tolerate a receive failure here.
    match transport.receive().await {
        Ok(response) => {
            let _ = SmpFrame::<os_management::ResetResult>::decode_with_cbor(&response);
        }
        Err(_) => {
            tlog!("[smp_upgrade] No response to reset (device likely rebooted)");
        }
    }

    tlog!("[smp_upgrade] Reset command sent");
    Ok(())
}

/// Cancel an in-progress firmware upload.
#[tauri::command]
pub async fn smp_cancel_upload() -> Result<(), String> {
    let state = SMP_STATE.lock().await;
    state.cancel_upload.store(true, Ordering::Relaxed);
    tlog!("[smp_upgrade] Upload cancel requested");
    Ok(())
}

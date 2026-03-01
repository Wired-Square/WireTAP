// BLE WiFi Provisioning module
//
// Communicates with Zephyr devices running the Wired Square WiFi provisioning
// GATT service to configure WiFi credentials over BLE.
//
// Service UUID: 14387800-130c-49e7-b877-2881c89cb258

use crate::ble_common;
use btleplug::api::{
    Central, CharPropFlags, Characteristic, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::Peripheral;
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

// ============================================================================
// GATT UUIDs
// ============================================================================

const WIFI_PROV_SERVICE_UUID: Uuid = ble_common::uuid_from_fields(0x14387800, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_SSID_UUID: Uuid = ble_common::uuid_from_fields(0x14387801, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_PASSPHRASE_UUID: Uuid = ble_common::uuid_from_fields(0x14387802, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_SECURITY_UUID: Uuid = ble_common::uuid_from_fields(0x14387803, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_CONTROL_UUID: Uuid = ble_common::uuid_from_fields(0x14387804, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_STATUS_UUID: Uuid = ble_common::uuid_from_fields(0x14387805, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
const CHAR_IP_ADDR_UUID: Uuid = ble_common::uuid_from_fields(0x14387806, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);

// Control byte values
const CONTROL_SAVE_CONNECT: u8 = 0x01;
const CONTROL_DELETE_ALL: u8 = 0x02;
const CONTROL_DISCONNECT: u8 = 0x03;

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Serialize)]
pub struct BleDevice {
    pub name: String,
    pub id: String,
    pub rssi: Option<i16>,
}

#[derive(Clone, Serialize)]
pub struct DeviceWifiState {
    pub ssid: Option<String>,
    pub security: Option<u8>,
    pub status: u8,
    pub ip_address: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct WifiCredentials {
    pub ssid: String,
    pub passphrase: Option<String>,
    pub security: u8,
}

#[derive(Clone, Serialize)]
pub struct ProvisioningStatus {
    pub status: String,
    pub status_code: u8,
}

// ============================================================================
// Module state
// ============================================================================

struct BleProvisionState {
    connected_peripheral: Option<Peripheral>,
    scanning: bool,
}

static BLE_STATE: Lazy<Arc<Mutex<BleProvisionState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(BleProvisionState {
        connected_peripheral: None,
        scanning: false,
    }))
});

// ============================================================================
// Helpers
// ============================================================================

/// Initialise the shared BLE adapter if not already done.
async fn ensure_adapter() -> Result<(), String> {
    ble_common::ensure_adapter().await
}

/// Get a clone of the shared BLE adapter.
async fn get_adapter() -> Result<btleplug::platform::Adapter, String> {
    let state = ble_common::BLE_ADAPTER.lock().await;
    state.adapter.clone().ok_or_else(|| "BLE adapter not initialised".to_string())
}

/// Find a GATT characteristic by UUID on the connected peripheral.
fn find_characteristic(peripheral: &Peripheral, uuid: Uuid) -> Option<Characteristic> {
    peripheral.characteristics().into_iter().find(|c| c.uuid == uuid)
}

fn status_code_to_string(code: u8) -> &'static str {
    match code {
        0x00 => "disconnected",
        0x01 => "connecting",
        0x02 => "connected",
        0x03 => "error",
        _ => "unknown",
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Start scanning for BLE devices advertising the WiFi provisioning service.
/// Discovered devices are emitted as `ble-device-discovered` events.
/// The scan auto-stops after ~10 seconds or when `ble_scan_stop` is called.
#[tauri::command]
pub async fn ble_scan_start(app: AppHandle) -> Result<(), String> {
    ensure_adapter().await?;

    let mut state = BLE_STATE.lock().await;
    if state.scanning {
        return Ok(());
    }
    state.scanning = true;
    drop(state);

    let adapter = get_adapter().await?;

    // Scan without a service UUID filter. On macOS, CoreBluetooth's scan
    // filter only matches UUIDs in the primary advertisement packet, but
    // Zephyr devices typically place 128-bit service UUIDs in the scan
    // response data instead.  We discover all devices and filter by
    // advertised service UUIDs on the application side.
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("Failed to start BLE scan: {e}"))?;

    tlog!("[ble_provision] Scan started (filtering for WiFi prov UUID {:?})", WIFI_PROV_SERVICE_UUID);

    // Spawn a task that polls for discovered peripherals periodically
    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut seen_ids = std::collections::HashSet::new();

        for _ in 0..20 {
            // Poll every 500ms for 10 seconds total
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Check if scan was stopped externally
            let state = BLE_STATE.lock().await;
            if !state.scanning {
                break;
            }
            drop(state);

            let adapter = match get_adapter().await {
                Ok(a) => a,
                Err(_) => break,
            };

            // List discovered peripherals
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

                    let name = props
                        .local_name
                        .clone()
                        .unwrap_or_else(|| id.clone());
                    let rssi = props.rssi;

                    // Log every named device for diagnostics
                    if props.local_name.is_some() {
                        tlog!(
                            "[ble_provision] Saw: name={}, id={}, services={:?}, service_data_keys={:?}",
                            name, id, props.services,
                            props.service_data.keys().collect::<Vec<_>>()
                        );
                    }

                    // Match devices that advertise the WiFi provisioning service UUID.
                    let advertises_service = props.services.contains(&WIFI_PROV_SERVICE_UUID)
                        || props.service_data.contains_key(&WIFI_PROV_SERVICE_UUID);
                    if !advertises_service {
                        continue;
                    }

                    seen_ids.insert(id.clone());

                    tlog!("[ble_provision] Matched: {} ({}), RSSI: {:?}", name, id, rssi);

                    let device = BleDevice { name, id, rssi };
                    let _ = app_clone.emit("ble-device-discovered", &device);
                }
            }
        }

        // Auto-stop scan after timeout
        let mut state = BLE_STATE.lock().await;
        if state.scanning {
            state.scanning = false;
            drop(state);
            if let Ok(adapter) = get_adapter().await {
                let _ = adapter.stop_scan().await;
            }
        } else {
            drop(state);
        }
        tlog!("[ble_provision] Scan finished");
        let _ = app_clone.emit("ble-scan-finished", ());
    });

    Ok(())
}

/// Stop an active BLE scan.
#[tauri::command]
pub async fn ble_scan_stop(_app: AppHandle) -> Result<(), String> {
    let mut state = BLE_STATE.lock().await;
    if !state.scanning {
        return Ok(());
    }
    state.scanning = false;
    drop(state);

    if let Ok(adapter) = get_adapter().await {
        adapter
            .stop_scan()
            .await
            .map_err(|e| format!("Failed to stop BLE scan: {e}"))?;
    }
    Ok(())
}

/// Connect to a BLE peripheral by its platform-specific ID string.
/// Discovers services and verifies the WiFi provisioning service is present.
/// Spawns a background task to detect unexpected disconnections and emit
/// `ble-device-disconnected` so the frontend can reset its state.
#[tauri::command]
pub async fn ble_connect(app: AppHandle, device_id: String) -> Result<(), String> {
    ensure_adapter().await?;

    // Disconnect any existing peripheral first
    {
        let mut state = BLE_STATE.lock().await;
        if let Some(old) = state.connected_peripheral.take() {
            let _ = old.disconnect().await;
            tlog!("[ble_provision] Disconnected previous peripheral before new connect");
        }
    }

    let adapter = get_adapter().await?;

    // Find the peripheral by ID
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("Failed to list peripherals: {e}"))?;

    let peripheral = peripherals
        .into_iter()
        .find(|p| p.id().to_string() == device_id)
        .ok_or_else(|| format!("Device '{}' not found", device_id))?;

    // Connect
    tlog!("[ble_provision] Connecting to {device_id}...");
    peripheral
        .connect()
        .await
        .map_err(|e| format!("Failed to connect: {e}"))?;

    // Discover services
    peripheral
        .discover_services()
        .await
        .map_err(|e| {
            // Disconnect on service discovery failure
            let p = peripheral.clone();
            tokio::spawn(async move { let _ = p.disconnect().await; });
            format!("Failed to discover services: {e}")
        })?;

    // Verify the WiFi provisioning service is present
    let has_service = peripheral
        .services()
        .iter()
        .any(|s| s.uuid == WIFI_PROV_SERVICE_UUID);

    if !has_service {
        let _ = peripheral.disconnect().await;
        return Err("Device does not have the WiFi provisioning service".to_string());
    }

    tlog!("[ble_provision] Connected to {device_id}");

    // Store the connected peripheral
    let mut state = BLE_STATE.lock().await;
    state.connected_peripheral = Some(peripheral.clone());
    drop(state);

    // Spawn a watchdog task that monitors the connection and emits an event
    // if the peripheral disconnects unexpectedly (e.g. out of range, device
    // reset, pairing failure).
    let app_clone = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            // Check if we're still the active peripheral
            let state = BLE_STATE.lock().await;
            let is_current = match &state.connected_peripheral {
                Some(p) => p.id() == peripheral.id(),
                None => false,
            };
            drop(state);

            if !is_current {
                // Another peripheral was connected or we were explicitly disconnected
                break;
            }

            // Check if still connected
            let connected = peripheral.is_connected().await.unwrap_or(false);
            if !connected {
                tlog!("[ble_provision] Watchdog: peripheral {device_id} disconnected unexpectedly");
                // Only emit disconnect if this peripheral is still the active
                // connection — another connect may have replaced it.
                let mut state = BLE_STATE.lock().await;
                let was_current =
                    if let Some(ref p) = state.connected_peripheral {
                        if p.id() == peripheral.id() {
                            state.connected_peripheral = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                drop(state);
                if was_current {
                    let _ = app_clone.emit("ble-device-disconnected", &device_id);
                }
                break;
            }
        }
    });

    Ok(())
}

/// Return a clone of the currently connected provisioning peripheral (if any).
/// Used by `smp_upgrade::smp_attach_ble` to share the BLE connection.
pub async fn get_connected_peripheral() -> Option<Peripheral> {
    let state = BLE_STATE.lock().await;
    state.connected_peripheral.clone()
}

/// Disconnect from the currently connected BLE peripheral.
#[tauri::command]
pub async fn ble_disconnect() -> Result<(), String> {
    let mut state = BLE_STATE.lock().await;
    if let Some(peripheral) = state.connected_peripheral.take() {
        tlog!("[ble_provision] Disconnecting from {:?}", peripheral.id());
        // Best-effort disconnect — the peripheral may already be gone
        let _ = peripheral.disconnect().await;
    }
    Ok(())
}

/// Delete all stored WiFi credentials on the connected device.
/// Writes 0x02 to the Control characteristic.
#[tauri::command]
pub async fn ble_delete_all_credentials() -> Result<(), String> {
    let state = BLE_STATE.lock().await;
    let peripheral = state
        .connected_peripheral
        .as_ref()
        .ok_or("Not connected to a device")?
        .clone();
    drop(state);

    let ctrl_char = find_characteristic(&peripheral, CHAR_CONTROL_UUID)
        .ok_or("Control characteristic not found")?;
    peripheral
        .write(&ctrl_char, &[CONTROL_DELETE_ALL], WriteType::WithResponse)
        .await
        .map_err(|e| format!("Failed to delete credentials: {e}"))?;

    tlog!("[ble_provision] Sent delete-all-credentials command");
    Ok(())
}

/// Disconnect the device from its current WiFi network.
/// Writes 0x03 to the Control characteristic.
#[tauri::command]
pub async fn ble_wifi_disconnect() -> Result<(), String> {
    let state = BLE_STATE.lock().await;
    let peripheral = state
        .connected_peripheral
        .as_ref()
        .ok_or("Not connected to a device")?
        .clone();
    drop(state);

    let ctrl_char = find_characteristic(&peripheral, CHAR_CONTROL_UUID)
        .ok_or("Control characteristic not found")?;
    peripheral
        .write(&ctrl_char, &[CONTROL_DISCONNECT], WriteType::WithResponse)
        .await
        .map_err(|e| format!("Failed to send WiFi disconnect: {e}"))?;

    tlog!("[ble_provision] Sent WiFi disconnect command");
    Ok(())
}

/// Read the current WiFi state from the connected device.
/// Returns SSID, security type, and connection status.
#[tauri::command]
pub async fn ble_read_device_state() -> Result<DeviceWifiState, String> {
    // Clone the peripheral and release the lock immediately so other
    // commands (provision, disconnect, watchdog) are not blocked while
    // we perform potentially slow GATT reads.
    let peripheral = {
        let state = BLE_STATE.lock().await;
        state
            .connected_peripheral
            .as_ref()
            .ok_or("Not connected to a device")?
            .clone()
    };

    // Helper: read a characteristic with a 5-second timeout to prevent hangs
    async fn read_with_timeout(
        peripheral: &Peripheral,
        char: &btleplug::api::Characteristic,
    ) -> Option<Vec<u8>> {
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            peripheral.read(char),
        )
        .await
        {
            Ok(Ok(data)) if !data.is_empty() => Some(data),
            Ok(Ok(_)) => None,
            Ok(Err(e)) => {
                tlog!("[ble_provision] Read failed for {:?}: {e}", char.uuid);
                None
            }
            Err(_) => {
                tlog!("[ble_provision] Read timed out for {:?}", char.uuid);
                None
            }
        }
    }

    // Read SSID
    let ssid = if let Some(char) = find_characteristic(&peripheral, CHAR_SSID_UUID) {
        if char.properties.contains(CharPropFlags::READ) {
            read_with_timeout(&peripheral, &char)
                .await
                .map(|data| String::from_utf8_lossy(&data).to_string())
        } else {
            None
        }
    } else {
        None
    };

    // Read security type
    let security = if let Some(char) = find_characteristic(&peripheral, CHAR_SECURITY_UUID) {
        if char.properties.contains(CharPropFlags::READ) {
            read_with_timeout(&peripheral, &char)
                .await
                .map(|data| data[0])
        } else {
            None
        }
    } else {
        None
    };

    // Read status
    let status = if let Some(char) = find_characteristic(&peripheral, CHAR_STATUS_UUID) {
        if char.properties.contains(CharPropFlags::READ) {
            read_with_timeout(&peripheral, &char)
                .await
                .map(|data| data[0])
                .unwrap_or(0x00)
        } else {
            0x00
        }
    } else {
        0x00
    };

    // Read IP address (4 raw bytes for IPv4)
    let ip_address = if let Some(char) = find_characteristic(&peripheral, CHAR_IP_ADDR_UUID) {
        if char.properties.contains(CharPropFlags::READ) {
            read_with_timeout(&peripheral, &char).await.and_then(|data| {
                if data.len() >= 4 {
                    let addr = format!("{}.{}.{}.{}", data[0], data[1], data[2], data[3]);
                    if addr == "0.0.0.0" { None } else { Some(addr) }
                } else {
                    None
                }
            })
        } else {
            None
        }
    } else {
        None
    };

    tlog!("[ble_provision] Device state: ssid={:?}, security={:?}, status={}, ip={:?}",
        ssid, security, status, ip_address);

    Ok(DeviceWifiState {
        ssid,
        security,
        status,
        ip_address,
    })
}

/// Write WiFi credentials to the device and send the save+connect command.
/// Emits `ble-provision-status` events as the device status changes.
#[tauri::command]
pub async fn ble_provision_wifi(
    app: AppHandle,
    credentials: WifiCredentials,
) -> Result<(), String> {
    let state = BLE_STATE.lock().await;
    let peripheral = state
        .connected_peripheral
        .as_ref()
        .ok_or("Not connected to a device")?
        .clone();
    drop(state);

    // Write SSID
    let ssid_char = find_characteristic(&peripheral, CHAR_SSID_UUID)
        .ok_or("SSID characteristic not found")?;
    peripheral
        .write(&ssid_char, credentials.ssid.as_bytes(), WriteType::WithResponse)
        .await
        .map_err(|e| format!("Failed to write SSID: {e}"))?;

    // Write passphrase (if provided)
    if let Some(ref passphrase) = credentials.passphrase {
        if !passphrase.is_empty() {
            let psk_char = find_characteristic(&peripheral, CHAR_PASSPHRASE_UUID)
                .ok_or("Passphrase characteristic not found")?;
            peripheral
                .write(&psk_char, passphrase.as_bytes(), WriteType::WithResponse)
                .await
                .map_err(|e| format!("Failed to write passphrase: {e}"))?;
        }
    }

    // Write security type
    let sec_char = find_characteristic(&peripheral, CHAR_SECURITY_UUID)
        .ok_or("Security characteristic not found")?;
    peripheral
        .write(&sec_char, &[credentials.security], WriteType::WithResponse)
        .await
        .map_err(|e| format!("Failed to write security type: {e}"))?;

    // Subscribe to status and IP address notifications before sending the command
    if let Some(status_char) = find_characteristic(&peripheral, CHAR_STATUS_UUID) {
        if status_char.properties.contains(CharPropFlags::NOTIFY) {
            match peripheral.subscribe(&status_char).await {
                Ok(()) => tlog!("[ble_provision] Subscribed to status notifications"),
                Err(e) => tlog!("[ble_provision] Failed to subscribe to status: {e}"),
            }
        } else {
            tlog!("[ble_provision] Status characteristic does not support NOTIFY");
        }
    } else {
        tlog!("[ble_provision] Status characteristic not found");
    }
    if let Some(ip_char) = find_characteristic(&peripheral, CHAR_IP_ADDR_UUID) {
        if ip_char.properties.contains(CharPropFlags::NOTIFY) {
            match peripheral.subscribe(&ip_char).await {
                Ok(()) => tlog!("[ble_provision] Subscribed to IP address notifications"),
                Err(e) => tlog!("[ble_provision] Failed to subscribe to IP address: {e}"),
            }
        } else {
            tlog!("[ble_provision] IP address characteristic does not support NOTIFY (properties: {:?})", ip_char.properties);
        }
    } else {
        tlog!("[ble_provision] IP address characteristic not found");
    }

    {
        // Spawn a task to forward status and IP notifications to the frontend.
        // The notifications() stream is multiplexed across all subscribed
        // characteristics — we dispatch on notification.uuid.
        let app_clone = app.clone();
        let peripheral_clone = peripheral.clone();
        tokio::spawn(async move {
            if let Ok(mut stream) = peripheral_clone.notifications().await {
                let mut got_ip = false;
                let mut terminal_status: Option<u8> = None;

                while let Some(notification) = stream.next().await {
                    tlog!("[ble_provision] Notification from {:?}: {:?}", notification.uuid, notification.value);
                    if notification.uuid == CHAR_STATUS_UUID {
                        let code = notification.value.first().copied().unwrap_or(0);
                        let status = ProvisioningStatus {
                            status: status_code_to_string(code).to_string(),
                            status_code: code,
                        };
                        let _ = app_clone.emit("ble-provision-status", &status);

                        if code == 0x03 {
                            // Error — stop immediately
                            break;
                        }
                        if code == 0x02 {
                            // Connected — wait for IP if we haven't got one yet
                            terminal_status = Some(code);
                            if got_ip {
                                break;
                            }
                        }
                    } else if notification.uuid == CHAR_IP_ADDR_UUID {
                        let data = &notification.value;
                        if data.len() >= 4 {
                            let addr = format!("{}.{}.{}.{}", data[0], data[1], data[2], data[3]);
                            tlog!("[ble_provision] IP address notification: {addr}");
                            if addr != "0.0.0.0" {
                                let _ = app_clone.emit("ble-provision-ip", &addr);
                                got_ip = true;
                                if terminal_status.is_some() {
                                    break;
                                }
                            }
                        }
                    }
                }

                // If we got a terminal status but no IP yet, wait briefly for it
                if terminal_status == Some(0x02) && !got_ip {
                    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
                    while tokio::time::Instant::now() < deadline {
                        match tokio::time::timeout(
                            deadline - tokio::time::Instant::now(),
                            stream.next(),
                        )
                        .await
                        {
                            Ok(Some(notification)) if notification.uuid == CHAR_IP_ADDR_UUID => {
                                let data = &notification.value;
                                if data.len() >= 4 {
                                    let addr = format!("{}.{}.{}.{}", data[0], data[1], data[2], data[3]);
                                    if addr != "0.0.0.0" {
                                        let _ = app_clone.emit("ble-provision-ip", &addr);
                                        break;
                                    }
                                }
                            }
                            _ => break,
                        }
                    }
                }
            }
        });
    }

    // Write control command: save credentials and connect
    let ctrl_char = find_characteristic(&peripheral, CHAR_CONTROL_UUID)
        .ok_or("Control characteristic not found")?;
    peripheral
        .write(&ctrl_char, &[CONTROL_SAVE_CONNECT], WriteType::WithResponse)
        .await
        .map_err(|e| format!("Failed to write control command: {e}"))?;

    Ok(())
}

/// Subscribe to status notifications from the connected device.
/// Emits `ble-provision-status` events when the device status changes.
#[tauri::command]
pub async fn ble_subscribe_status(app: AppHandle) -> Result<(), String> {
    let state = BLE_STATE.lock().await;
    let peripheral = state
        .connected_peripheral
        .as_ref()
        .ok_or("Not connected to a device")?
        .clone();
    drop(state);

    let status_char = find_characteristic(&peripheral, CHAR_STATUS_UUID)
        .ok_or("Status characteristic not found")?;

    if !status_char.properties.contains(CharPropFlags::NOTIFY) {
        return Err("Status characteristic does not support notifications".to_string());
    }

    peripheral
        .subscribe(&status_char)
        .await
        .map_err(|e| format!("Failed to subscribe to status: {e}"))?;

    let app_clone = app.clone();
    tokio::spawn(async move {
        if let Ok(mut stream) = peripheral.notifications().await {
            while let Some(notification) = stream.next().await {
                if notification.uuid == CHAR_STATUS_UUID {
                    let code = notification.value.first().copied().unwrap_or(0);
                    let status = ProvisioningStatus {
                        status: status_code_to_string(code).to_string(),
                        status_code: code,
                    };
                    let _ = app_clone.emit("ble-provision-status", &status);
                }
            }
        }
    });

    Ok(())
}

/// Detect the host machine's current WiFi SSID.
/// Returns `None` on platforms where detection is unavailable (e.g. iOS).
#[tauri::command]
pub async fn ble_get_host_wifi_ssid() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("/usr/sbin/networksetup")
            .args(["-getairportnetwork", "en0"])
            .output()
            .await
            .map_err(|e| format!("Failed to run networksetup: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Output format: "Current Wi-Fi Network: <SSID>"
        if let Some(ssid) = stdout.strip_prefix("Current Wi-Fi Network: ") {
            let ssid = ssid.trim();
            if !ssid.is_empty() {
                return Ok(Some(ssid.to_string()));
            }
        }
        Ok(None)
    }

    #[cfg(target_os = "windows")]
    {
        let output = tokio::process::Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .output()
            .await
            .map_err(|e| format!("Failed to run netsh: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse line: "    SSID                   : MyNetwork"
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("SSID") && !trimmed.starts_with("BSSID") {
                if let Some(ssid) = trimmed.split(':').nth(1) {
                    let ssid = ssid.trim();
                    if !ssid.is_empty() {
                        return Ok(Some(ssid.to_string()));
                    }
                }
            }
        }
        Ok(None)
    }

    #[cfg(target_os = "linux")]
    {
        let output = tokio::process::Command::new("nmcli")
            .args(["-t", "-f", "active,ssid", "dev", "wifi"])
            .output()
            .await
            .map_err(|e| format!("Failed to run nmcli: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse line: "yes:MyNetwork"
        for line in stdout.lines() {
            if let Some(ssid) = line.strip_prefix("yes:") {
                if !ssid.is_empty() {
                    return Ok(Some(ssid.to_string()));
                }
            }
        }
        Ok(None)
    }

    #[cfg(target_os = "ios")]
    {
        // Apple restricts WiFi SSID access on iOS without special entitlements
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uuid_encoding() {
        let uuid = ble_common::uuid_from_fields(0x14387800, 0x130c, 0x49e7, 0xb877, 0x2881c89cb258);
        assert_eq!(
            uuid.to_string(),
            "14387800-130c-49e7-b877-2881c89cb258",
            "WiFi provisioning service UUID mismatch"
        );
    }

}

// BLE WiFi provisioning module
//
// Drives `framelink::WifiProvSession` handles vended by
// `framelink::Discovery` (single source of truth for BLE connection
// state — see `device_scan` for the discovery handle). Each Tauri
// command takes the target `device_id`, fetches the cached session
// via `discovery.open_wifi_prov(&id)`, and runs the operation.
// Tear-down is the unified `release_device(device_id)` command in
// `device_scan` — there is no per-protocol `disconnect` here.

use crate::device_scan::{canonical_device_id, device_scan_start, device_scan_stop, discovery_handle};
use framelink::{
    Discovery, ProvisioningEvent as FlProvisioningEvent, WifiCredentials as FlWifiCredentials,
    WifiProvSession, WifiSecurity, WifiStatus,
};
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

// ============================================================================
// Wire types
// ============================================================================

/// Snapshot of the device's WiFi state, as the frontend already deserialises
/// it. `security` and `status` are firmware wire bytes, not enums, so any
/// future firmware extension round-trips through the UI without a backend
/// update.
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

/// Payload of `ble-provision-status` events. `status_code` is the raw
/// firmware byte; `status` is its short stable name for UI rendering.
#[derive(Clone, Serialize)]
pub struct ProvisioningStatus {
    pub status: String,
    pub status_code: u8,
}

// ============================================================================
// Module state
// ============================================================================

struct BleProvisionState {
    /// Background task forwarding `session.watch()` events to the
    /// frontend. Holds an `Arc<WifiProvSession>` clone for its
    /// lifetime; aborted by `ble_subscribe_status` (when restarting
    /// the watch) and by `device_scan::release_device` indirectly
    /// (the task exits naturally once the lease is dropped and the
    /// notify stream errors out).
    watch_task: Option<JoinHandle<()>>,
}

static STATE: Lazy<Arc<Mutex<BleProvisionState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(BleProvisionState { watch_task: None }))
});

// ============================================================================
// Helpers
// ============================================================================

fn wifi_status_byte(status: WifiStatus) -> u8 {
    match status {
        WifiStatus::Disconnected => 0,
        WifiStatus::Connecting => 1,
        WifiStatus::Connected => 2,
        WifiStatus::Error => 3,
    }
}

fn provisioning_status_payload(status: WifiStatus) -> ProvisioningStatus {
    let code = wifi_status_byte(status);
    let name = match code {
        0 => "disconnected",
        1 => "connecting",
        2 => "connected",
        3 => "error",
        _ => "unknown",
    };
    ProvisioningStatus {
        status: name.to_string(),
        status_code: code,
    }
}

/// Resolve `device_id` to a cached `Arc<WifiProvSession>`. Opens (and
/// caches) the session on first call for that id; subsequent calls
/// return clones of the same `Arc`.
async fn session_for(device_id: &str) -> Result<(Discovery, Arc<WifiProvSession>), String> {
    let id = canonical_device_id(device_id.to_string());
    let discovery = discovery_handle().await?;
    let session = discovery
        .open_wifi_prov(&id)
        .await
        .map_err(|e| format!("Failed to open WiFi-prov session for {id}: {e}"))?;
    Ok((discovery, session))
}

// ============================================================================
// Tauri commands — scan
// ============================================================================

/// Legacy alias for the unified `device_scan_start` — the BLE-only scan
/// has been folded into one Discovery in framelink, so both routes drive
/// the same scanners and emit the same `device-discovered` events.
#[tauri::command]
pub async fn ble_scan_start(app: AppHandle) -> Result<(), String> {
    device_scan_start(app).await
}

#[tauri::command]
pub async fn ble_scan_stop(app: AppHandle) -> Result<(), String> {
    device_scan_stop(app).await
}

// ============================================================================
// Tauri commands — connection
// ============================================================================

/// Warm the WiFi-prov session cache for `device_id`. Idempotent — the
/// `Discovery` cache returns the same `Arc<WifiProvSession>` to
/// subsequent operation commands. Tear-down goes through
/// `device_scan::release_device(device_id)`.
#[tauri::command]
pub async fn ble_connect(_app: AppHandle, device_id: String) -> Result<(), String> {
    let id = canonical_device_id(device_id);
    let discovery = discovery_handle().await?;
    discovery
        .open_wifi_prov(&id)
        .await
        .map_err(|e| format!("Failed to open WiFi-prov session for {id}: {e}"))?;
    tlog!("[ble_provision] WiFi-prov session ready for {}", id);
    Ok(())
}

// ============================================================================
// Tauri commands — operations on the session
// ============================================================================

#[tauri::command]
pub async fn ble_delete_all_credentials(device_id: String) -> Result<(), String> {
    let (_d, session) = session_for(&device_id).await?;
    session
        .forget()
        .await
        .map_err(|e| format!("Failed to wipe credentials: {e}"))
}

#[tauri::command]
pub async fn ble_wifi_disconnect(device_id: String) -> Result<(), String> {
    let (_d, session) = session_for(&device_id).await?;
    session
        .disconnect()
        .await
        .map_err(|e| format!("Failed to disconnect WiFi on device: {e}"))
}

#[tauri::command]
pub async fn ble_read_device_state(device_id: String) -> Result<DeviceWifiState, String> {
    let (_d, session) = session_for(&device_id).await?;
    let s = session
        .status()
        .await
        .map_err(|e| format!("Failed to read device state: {e}"))?;
    Ok(DeviceWifiState {
        ssid: s.ssid,
        security: s.security.map(|sec| sec.byte()),
        status: wifi_status_byte(s.status),
        ip_address: s.ip_address.map(|ip| ip.to_string()),
    })
}

/// Push WiFi credentials to the device and stream the resulting status
/// transitions back as `ble-provision-status` / `ble-provision-ip` Tauri
/// events. Returns once the device reaches a terminal state (Connected
/// with IP, Connected without IP after the grace window, or Error).
#[tauri::command]
pub async fn ble_provision_wifi(
    app: AppHandle,
    device_id: String,
    credentials: WifiCredentials,
) -> Result<(), String> {
    let (_d, session) = session_for(&device_id).await?;
    let creds = FlWifiCredentials {
        ssid: credentials.ssid,
        passphrase: credentials.passphrase,
        security: WifiSecurity::from_byte(credentials.security),
    };

    let mut stream = Box::pin(session.provision(creds));
    while let Some(event) = stream.next().await {
        match event {
            Ok(FlProvisioningEvent::Status { status }) => {
                let _ = app.emit("ble-provision-status", &provisioning_status_payload(status));
            }
            Ok(FlProvisioningEvent::IpAddress { address }) => {
                let _ = app.emit("ble-provision-ip", address.to_string());
            }
            Err(e) => {
                return Err(format!("Provisioning failed: {e}"));
            }
        }
    }
    Ok(())
}

/// Subscribe to live status / IP-address changes from the device until
/// the BLE link drops or the device is released. Read-only — never
/// stages new credentials.
#[tauri::command]
pub async fn ble_subscribe_status(app: AppHandle, device_id: String) -> Result<(), String> {
    let (_d, session) = session_for(&device_id).await?;

    let mut state = STATE.lock().await;
    if let Some(t) = state.watch_task.take() {
        t.abort();
    }

    let app_clone = app.clone();
    let session_clone = Arc::clone(&session);
    let task = tokio::spawn(async move {
        let mut stream = Box::pin(session_clone.watch());
        while let Some(event) = stream.next().await {
            match event {
                Ok(FlProvisioningEvent::Status { status }) => {
                    let _ = app_clone
                        .emit("ble-provision-status", &provisioning_status_payload(status));
                }
                Ok(FlProvisioningEvent::IpAddress { address }) => {
                    let _ = app_clone.emit("ble-provision-ip", address.to_string());
                }
                Err(e) => {
                    tlog!("[ble_provision] watch stream ended: {e}");
                    break;
                }
            }
        }
    });
    state.watch_task = Some(task);
    Ok(())
}

// ============================================================================
// Tauri commands — host-side helpers
// ============================================================================

/// Detect the host machine's current WiFi SSID. Returns `None` on
/// platforms where detection is unavailable (iOS) or no WiFi is active.
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
        Ok(None)
    }
}

// SMP firmware upgrade module
//
// Drives `framelink::SmpSession` (opened via the shared `Discovery`
// from [`crate::device_scan`]) for both BLE and UDP transports. The
// session vendors its own SMP transport so we no longer pull in
// `mcumgr-smp` directly — framelink takes that dependency.
//
// The Tauri command surface is unchanged; the session reuses one BLE
// connection with any sibling `WifiProvSession` opened by
// `ble_provision`.

use crate::device_scan::{
    canonical_device_id, device_scan_start, device_scan_stop, discovery_handle,
};
use framelink::{CapabilitySet, ImageSlot as FlImageSlot, SmpSession, Transport};
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

// ============================================================================
// Wire types
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

// ============================================================================
// Module state
// ============================================================================

struct SmpUpgradeState {
    /// Active SMP session — `None` until `smp_connect_ble` /
    /// `smp_connect_udp`.
    session: Option<Arc<SmpSession>>,
    /// Cancel signal for an in-flight `smp_upload_firmware`. Set by
    /// `smp_cancel_upload`; awaited by the upload loop alongside the
    /// progress stream.
    upload_cancel: Arc<Notify>,
}

static STATE: Lazy<Arc<Mutex<SmpUpgradeState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(SmpUpgradeState {
        session: None,
        upload_cancel: Arc::new(Notify::new()),
    }))
});

// ============================================================================
// Helpers
// ============================================================================

async fn require_session() -> Result<Arc<SmpSession>, String> {
    let state = STATE.lock().await;
    state
        .session
        .clone()
        .ok_or_else(|| "No active SMP session — call smp_connect_ble or smp_connect_udp first".to_string())
}

fn map_image_slot(img: FlImageSlot) -> ImageSlotInfo {
    ImageSlotInfo {
        slot: img.slot,
        version: img.version,
        hash: hex::encode(&img.hash),
        bootable: img.bootable,
        pending: img.pending,
        confirmed: img.confirmed,
        active: img.active,
        permanent: img.permanent,
        image: img.image,
    }
}

// ============================================================================
// Tauri commands — scan
// ============================================================================

#[tauri::command]
pub async fn smp_scan_start(app: AppHandle) -> Result<(), String> {
    device_scan_start(app).await
}

#[tauri::command]
pub async fn smp_scan_stop(app: AppHandle) -> Result<(), String> {
    device_scan_stop(app).await
}

// ============================================================================
// Tauri commands — connect / disconnect
// ============================================================================

/// Connect to a BLE peripheral by its framelink DeviceId (or legacy
/// btleplug id without the `ble:` prefix).
///
/// If a sibling WiFi-prov session is already alive on the same device,
/// the underlying BLE connection is shared.
#[tauri::command]
pub async fn smp_connect_ble(_app: AppHandle, device_id: String) -> Result<(), String> {
    let id = canonical_device_id(device_id);
    let discovery = discovery_handle().await?;
    let session = discovery
        .open_smp_ble(&id)
        .await
        .map_err(|e| format!("Failed to open SMP-BLE session for {id}: {e}"))?;

    let mut state = STATE.lock().await;
    state.session = Some(Arc::new(session));
    tlog!("[smp_upgrade] SMP-BLE session opened on {}", id);
    Ok(())
}

/// Reconnect over BLE by device name, polling Discovery for a fresh
/// match. Used after a firmware test-boot — the device's btleplug
/// peripheral identifier rotates across the reboot, so the cached
/// `device_id` from before the upload is stale, but the local name
/// (e.g. "WiredFlexLink-4CD4") is firmware-stable.
///
/// Iterates until either a BLE+SMP-capable device with the matching
/// name comes back and `open_smp_ble` succeeds, or the timeout
/// elapses (the device may still be booting; the loop also covers
/// the brief window where Discovery still holds the pre-reboot
/// peripheral handle but it's no longer connectable).
#[tauri::command]
pub async fn smp_reconnect_ble_by_name(
    name: String,
    timeout_secs: u32,
) -> Result<(), String> {
    let discovery = discovery_handle().await?;
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(timeout_secs.max(1) as u64);
    let mut last_err: Option<String> = None;

    loop {
        let candidate = discovery
            .devices()
            .await
            .into_iter()
            .find(|d| {
                d.name() == name
                    && d.transports().contains(&Transport::Ble)
                    && d.capabilities().contains(CapabilitySet::SMP)
            });

        if let Some(device) = candidate {
            let id = device.id().clone();
            match discovery.open_smp_ble(&id).await {
                Ok(session) => {
                    let mut state = STATE.lock().await;
                    state.session = Some(Arc::new(session));
                    tlog!("[smp_upgrade] SMP-BLE re-opened on {} ({})", name, id);
                    return Ok(());
                }
                Err(e) => last_err = Some(e.to_string()),
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(match last_err {
                Some(e) => format!(
                    "Device '{name}' did not reconnect within {timeout_secs}s: {e}"
                ),
                None => format!(
                    "Device '{name}' did not reappear within {timeout_secs}s"
                ),
            });
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

/// Connect over UDP. Takes the framelink `DeviceId` for the
/// `_mcumgr._udp` mDNS entry directly (e.g.
/// `mdns:udp:WiredFlexLink-9C1C._mcumgr._udp.local.`) — no
/// snapshot reverse lookup, mirrors `smp_connect_ble`.
#[tauri::command]
pub async fn smp_connect_udp(device_id: String) -> Result<(), String> {
    let id = canonical_device_id(device_id);
    let discovery = discovery_handle().await?;
    let session = discovery
        .open_smp_udp(&id)
        .await
        .map_err(|e| format!("Failed to open SMP-UDP session for {id}: {e}"))?;

    let mut state = STATE.lock().await;
    state.session = Some(Arc::new(session));
    tlog!("[smp_upgrade] SMP-UDP session opened on {}", id);
    Ok(())
}

#[tauri::command]
pub async fn smp_disconnect() -> Result<(), String> {
    let mut state = STATE.lock().await;
    state.session = None;
    tlog!("[smp_upgrade] SMP session dropped");
    Ok(())
}

// ============================================================================
// Tauri commands — image management
// ============================================================================

#[tauri::command]
pub async fn smp_list_images() -> Result<Vec<ImageSlotInfo>, String> {
    let session = require_session().await?;
    let images = session
        .list_images()
        .await
        .map_err(|e| format!("Failed to list images: {e}"))?;
    Ok(images.into_iter().map(map_image_slot).collect())
}

/// Upload a firmware binary, emitting `smp-upload-progress` after each
/// ack'd chunk and `smp-upload-complete` once the device has confirmed
/// the final write. `smp_cancel_upload` interrupts the in-flight upload
/// between chunks.
#[tauri::command]
pub async fn smp_upload_firmware(
    app: AppHandle,
    file_path: String,
    image: Option<u8>,
) -> Result<(), String> {
    let session = require_session().await?;
    let data = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read firmware file: {e}"))?;
    let total_bytes = data.len();
    tlog!(
        "[smp_upgrade] Starting firmware upload: {} ({} bytes)",
        file_path,
        total_bytes
    );

    // `Notify::notify_waiters` only wakes already-waiting tasks (no
    // queueing), so a fresh `cancel.notified()` future starts clean —
    // no drain needed.
    let cancel = {
        let state = STATE.lock().await;
        Arc::clone(&state.upload_cancel)
    };

    let mut stream = Box::pin(session.upload(&data, image));

    loop {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                tlog!("[smp_upgrade] Upload cancelled by user");
                return Err("Upload cancelled".to_string());
            }
            next = stream.next() => match next {
                Some(Ok(progress)) => {
                    let percent = if progress.total_bytes == 0 {
                        100.0
                    } else {
                        (progress.bytes_sent as f32 / progress.total_bytes as f32) * 100.0
                    };
                    let _ = app.emit(
                        "smp-upload-progress",
                        &UploadProgress {
                            bytes_sent: progress.bytes_sent,
                            total_bytes: progress.total_bytes,
                            percent,
                        },
                    );
                }
                Some(Err(e)) => {
                    return Err(format!("Upload failed: {e}"));
                }
                None => break,
            }
        }
    }

    tlog!("[smp_upgrade] Upload complete ({} bytes)", total_bytes);
    let _ = app.emit("smp-upload-complete", ());
    Ok(())
}

#[tauri::command]
pub async fn smp_test_image(hash: Vec<u8>) -> Result<(), String> {
    let session = require_session().await?;
    session
        .test(&hash)
        .await
        .map_err(|e| format!("Failed to mark image for test: {e}"))?;
    tlog!("[smp_upgrade] Image marked for test boot");
    Ok(())
}

#[tauri::command]
pub async fn smp_confirm_image(hash: Vec<u8>) -> Result<(), String> {
    let session = require_session().await?;
    session
        .confirm(&hash)
        .await
        .map_err(|e| format!("Failed to confirm image: {e}"))?;
    tlog!("[smp_upgrade] Image confirmed");
    Ok(())
}

#[tauri::command]
pub async fn smp_reset_device() -> Result<(), String> {
    let session = require_session().await?;
    session
        .reset()
        .await
        .map_err(|e| format!("Failed to reset device: {e}"))?;
    tlog!("[smp_upgrade] Reset command sent");
    Ok(())
}

#[tauri::command]
pub async fn smp_cancel_upload() -> Result<(), String> {
    let state = STATE.lock().await;
    state.upload_cancel.notify_waiters();
    tlog!("[smp_upgrade] Upload cancel requested");
    Ok(())
}

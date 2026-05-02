//! Firmware flashers exposed through the Serial app.
//!
//! - ESP32 family: esptool-style serial bootloader (uses `espflash` crate).
//! - STM32: USB DFU 1.1 / DfuSe (uses `dfu-nusb` + `dfu-core`).
//!
//! The Tauri commands here own the command surface and progress channel
//! (`flasher-progress` event). The actual flashing happens in the
//! `esp_flasher` and `dfu_flasher` submodules. The whole module is
//! desktop-only — `serialport` (ESP32) and `nusb` (DFU) are not available
//! on iOS, so the module is gated at the `mod flashers;` declaration in
//! `lib.rs`.

#![cfg(not(target_os = "ios"))]

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub mod dfu_flasher;
pub mod esp_flasher;

pub const FLASHER_PROGRESS_EVENT: &str = "flasher-progress";

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FlashPhase {
    Connecting,
    Erasing,
    Writing,
    Verifying,
    Done,
    Error,
    Cancelled,
}

#[derive(Clone, Serialize, Debug)]
pub struct FlasherProgress {
    pub flash_id: String,
    pub phase: FlashPhase,
    pub bytes_done: u64,
    pub bytes_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
pub struct EspChipInfo {
    pub chip: String,
    pub features: Vec<String>,
    pub mac: String,
    pub flash_size_bytes: Option<u64>,
}

#[derive(Clone, Serialize, Debug)]
pub struct DfuDeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub serial: String,
    pub display_name: String,
}

/// Cancellation registry — flasher tasks check this flag periodically.
static CANCEL_FLAGS: Lazy<Mutex<std::collections::HashMap<String, bool>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

pub(crate) fn register_flash(flash_id: &str) {
    let mut flags = CANCEL_FLAGS.lock().unwrap();
    flags.insert(flash_id.to_string(), false);
}

#[allow(dead_code)] // used by esp_flasher / dfu_flasher loops once wired up
pub(crate) fn is_cancelled(flash_id: &str) -> bool {
    CANCEL_FLAGS
        .lock()
        .unwrap()
        .get(flash_id)
        .copied()
        .unwrap_or(false)
}

pub(crate) fn clear_flash(flash_id: &str) {
    CANCEL_FLAGS.lock().unwrap().remove(flash_id);
}

fn request_cancel(flash_id: &str) {
    if let Some(flag) = CANCEL_FLAGS.lock().unwrap().get_mut(flash_id) {
        *flag = true;
    }
}

pub(crate) fn emit_progress(app: &AppHandle, progress: FlasherProgress) {
    let _ = app.emit(FLASHER_PROGRESS_EVENT, progress);
}

fn new_flash_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}_{:x}", nanos as u64)
}

// ============================================================================
// Tauri commands — ESP32
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_detect_chip(port: String, baud: u32) -> Result<EspChipInfo, String> {
    esp_flasher::detect_chip(port, baud).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_flash(
    app: AppHandle,
    port: String,
    baud: u32,
    image_path: String,
    address: u32,
) -> Result<String, String> {
    let flash_id = new_flash_id("esp");
    register_flash(&flash_id);
    let id_clone = flash_id.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = esp_flasher::flash(
            app_clone.clone(),
            id_clone.clone(),
            port,
            baud,
            image_path,
            address,
        )
        .await;
        match result {
            Ok(()) => emit_progress(
                &app_clone,
                FlasherProgress {
                    flash_id: id_clone.clone(),
                    phase: FlashPhase::Done,
                    bytes_done: 0,
                    bytes_total: 0,
                    message: None,
                },
            ),
            Err(err) => emit_progress(
                &app_clone,
                FlasherProgress {
                    flash_id: id_clone.clone(),
                    phase: FlashPhase::Error,
                    bytes_done: 0,
                    bytes_total: 0,
                    message: Some(err),
                },
            ),
        }
        clear_flash(&id_clone);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_esp_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

// ============================================================================
// Tauri commands — STM32 DFU
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_dfu_list_devices() -> Result<Vec<DfuDeviceInfo>, String> {
    dfu_flasher::list_devices().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_dfu_flash(
    app: AppHandle,
    usb_serial: String,
    image_path: String,
    address: u32,
) -> Result<String, String> {
    let flash_id = new_flash_id("dfu");
    register_flash(&flash_id);
    let id_clone = flash_id.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = dfu_flasher::flash(
            app_clone.clone(),
            id_clone.clone(),
            usb_serial,
            image_path,
            address,
        )
        .await;
        match result {
            Ok(()) => emit_progress(
                &app_clone,
                FlasherProgress {
                    flash_id: id_clone.clone(),
                    phase: FlashPhase::Done,
                    bytes_done: 0,
                    bytes_total: 0,
                    message: None,
                },
            ),
            Err(err) => emit_progress(
                &app_clone,
                FlasherProgress {
                    flash_id: id_clone.clone(),
                    phase: FlashPhase::Error,
                    bytes_done: 0,
                    bytes_total: 0,
                    message: Some(err),
                },
            ),
        }
        clear_flash(&id_clone);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_dfu_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

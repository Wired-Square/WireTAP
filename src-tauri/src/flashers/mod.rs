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

/// Flasher tuning passed in from the UI. Every field is optional — `None`
/// means "let espflash decide / leave at its default". Mirrors the knobs on
/// the `esptool ... write-flash` command line.
#[derive(Clone, Deserialize, Default, Debug)]
#[serde(default)]
pub struct EspFlashOptions {
    /// Forced chip type (`esp32`, `esp32s3`, …). `None` = auto-detect.
    pub chip: Option<String>,
    /// Bootloader baud rate. `None` defaults to 460_800.
    pub flash_baud: Option<u32>,
    /// Flash mode (`dio`, `qio`, `qout`, `dout`).
    pub flash_mode: Option<String>,
    /// Flash frequency (`40MHz`, `80MHz`, `26MHz`, `20MHz`).
    pub flash_freq: Option<String>,
    /// Flash size (`4MB`, `8MB`, `16MB`, …).
    pub flash_size: Option<String>,
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
pub async fn flasher_esp_detect_chip(
    port: String,
    options: Option<EspFlashOptions>,
) -> Result<EspChipInfo, String> {
    esp_flasher::detect_chip(port, options.unwrap_or_default()).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_flash(
    app: AppHandle,
    port: String,
    image_path: String,
    address: u32,
    options: Option<EspFlashOptions>,
) -> Result<String, String> {
    let flash_id = new_flash_id("esp");
    register_flash(&flash_id);
    let id_clone = flash_id.clone();
    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let result = esp_flasher::flash(
            app_clone.clone(),
            id_clone.clone(),
            port,
            image_path,
            address,
            opts,
        )
        .await;
        finalise_flash_result(&app_clone, &id_clone, result);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_read_flash(
    app: AppHandle,
    port: String,
    output_path: String,
    offset: u32,
    size: Option<u32>,
    options: Option<EspFlashOptions>,
) -> Result<String, String> {
    let flash_id = new_flash_id("esp");
    register_flash(&flash_id);
    let id_clone = flash_id.clone();
    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let result = esp_flasher::read_flash(
            app_clone.clone(),
            id_clone.clone(),
            port,
            output_path,
            offset,
            size,
            opts,
        )
        .await;
        finalise_flash_result(&app_clone, &id_clone, result);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_erase(
    app: AppHandle,
    port: String,
    options: Option<EspFlashOptions>,
) -> Result<String, String> {
    let flash_id = new_flash_id("esp");
    register_flash(&flash_id);
    let id_clone = flash_id.clone();
    let app_clone = app.clone();
    let opts = options.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let result =
            esp_flasher::erase(app_clone.clone(), id_clone.clone(), port, opts).await;
        finalise_flash_result(&app_clone, &id_clone, result);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_esp_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

/// Final-status emitter used by every async ESP/DFU runner. The `flash` /
/// `erasing` / `writing` phases all converge to either Done or Error here so
/// the front-end progress UI can settle on a terminal state.
fn finalise_flash_result(app: &AppHandle, flash_id: &str, result: Result<(), String>) {
    let cancelled = is_cancelled(flash_id);
    match result {
        Ok(()) => emit_progress(
            app,
            FlasherProgress {
                flash_id: flash_id.to_string(),
                phase: FlashPhase::Done,
                bytes_done: 0,
                bytes_total: 0,
                message: None,
            },
        ),
        Err(err) if cancelled => emit_progress(
            app,
            FlasherProgress {
                flash_id: flash_id.to_string(),
                phase: FlashPhase::Cancelled,
                bytes_done: 0,
                bytes_total: 0,
                message: Some(err),
            },
        ),
        Err(err) => emit_progress(
            app,
            FlasherProgress {
                flash_id: flash_id.to_string(),
                phase: FlashPhase::Error,
                bytes_done: 0,
                bytes_total: 0,
                message: Some(err),
            },
        ),
    }
    clear_flash(flash_id);
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
        finalise_flash_result(&app_clone, &id_clone, result);
    });
    Ok(flash_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_dfu_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

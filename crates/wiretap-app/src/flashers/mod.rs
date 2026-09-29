//! Firmware flashers exposed through the Serial app: ESP32 serial bootloader,
//! STM32 USB DFU and STM32 UART (AN3155), all from `wslib-mcu-flash`.
//!
//! The Tauri commands here own the command surface and progress channel
//! (`flasher-progress` event). The whole module is desktop-only — the crate's
//! serial and USB backends are not available on iOS, so the module is gated
//! at the `mod flashers;` declaration in `lib.rs`.

#![cfg(not(target_os = "ios"))]

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use wslib_mcu_flash::detect::Detected;
use wslib_mcu_flash::dfu::{self, DfuDeviceInfo};
use wslib_mcu_flash::esp::{self, EspChipInfo};
use wslib_mcu_flash::stm32_uart::{self, parse_pin, Pin, Stm32ChipInfo, Stm32UartOptions};
use wslib_mcu_flash::{FlashError, FlashProgress, FlashStage};

pub const FLASHER_PROGRESS_EVENT: &str = "flasher-progress";

#[derive(Clone, Copy, Serialize, Deserialize, Debug)]
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

impl From<FlashStage> for FlashPhase {
    fn from(stage: FlashStage) -> Self {
        match stage {
            FlashStage::Connecting => FlashPhase::Connecting,
            FlashStage::Erasing => FlashPhase::Erasing,
            FlashStage::Writing => FlashPhase::Writing,
            FlashStage::Verifying | FlashStage::Resetting | FlashStage::Booting => {
                FlashPhase::Verifying
            }
        }
    }
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

/// Flasher tuning passed in from the UI. Every field is optional — `None`
/// means "let espflash decide / leave at its default". Mirrors the knobs on
/// the `esptool ... write-flash` command line.
#[derive(Clone, Deserialize, Default, Debug)]
#[serde(default)]
pub struct EspFlashOptions {
    /// Forced chip type (`esp32`, `esp32s3`, …). `None` = auto-detect.
    pub chip: Option<String>,
    /// Bootloader baud rate. `None` defaults to 921_600.
    pub flash_baud: Option<u32>,
    /// Flash mode (`dio`, `qio`, `qout`, `dout`).
    pub flash_mode: Option<String>,
    /// Flash frequency (`40MHz`, `80MHz`, `26MHz`, `20MHz`).
    pub flash_freq: Option<String>,
    /// Flash size (`4MB`, `8MB`, `16MB`, …).
    pub flash_size: Option<String>,
}

impl EspFlashOptions {
    fn parse(&self) -> Result<esp::EspFlashOptions, FlashError> {
        Ok(esp::EspFlashOptions {
            chip: esp::parse_chip(self.chip.as_deref())?,
            flash_baud: self.flash_baud,
            flash_mode: esp::parse_flash_mode(self.flash_mode.as_deref())?,
            flash_freq: esp::parse_flash_freq(self.flash_freq.as_deref())?,
            flash_size: esp::parse_flash_size(self.flash_size.as_deref())?,
        })
    }
}

/// Tuning knobs for the STM32 UART flasher. Pin mapping models the
/// stm32flash-style convention (DTR=BOOT0, RTS=NRST) but is fully
/// configurable for boards that wire it differently — the `"none"` setting
/// disables drive of that line, leaving the user to enter the bootloader
/// manually.
#[derive(Clone, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Stm32FlashOptions {
    /// Pin driving BOOT0. `"rts"` | `"dtr"` | `"none"`. Default `"dtr"`.
    pub boot0_pin: Option<String>,
    /// Pin driving NRST. `"rts"` | `"dtr"` | `"none"`. Default `"rts"`.
    pub reset_pin: Option<String>,
    /// Invert BOOT0 polarity. Default `false` (asserted high = bootloader).
    pub boot0_invert: Option<bool>,
    /// Invert RESET polarity. Default `true` (active-low NRST through an RC).
    pub reset_invert: Option<bool>,
    /// Bootloader baud (1200..=115200 per AN3155). Default 115_200.
    pub baud: Option<u32>,
}

impl From<&Stm32FlashOptions> for Stm32UartOptions {
    fn from(opts: &Stm32FlashOptions) -> Self {
        Self {
            boot0: parse_pin(opts.boot0_pin.as_deref(), Some(Pin::Dtr)),
            reset: parse_pin(opts.reset_pin.as_deref(), Some(Pin::Rts)),
            boot0_invert: opts.boot0_invert.unwrap_or(false),
            reset_invert: opts.reset_invert.unwrap_or(true),
            baud: opts.baud.unwrap_or(stm32_uart::DEFAULT_BAUD),
        }
    }
}

/// Result returned to the frontend after a successful detection.
///
/// `extra` carries the original chip-info struct (`EspChipInfo` or
/// `Stm32ChipInfo`) serialised as JSON, so the per-driver UI can display
/// extra fields (MAC for ESP, RDP level for STM32) without us having to
/// merge every variant into a single struct.
#[derive(Clone, Serialize, Debug)]
pub struct DetectedChip {
    /// Driver registry id on the frontend (`"esp-uart"` | `"stm32-uart"`).
    pub driver_id: String,
    /// Manufacturer badge string (`"ESP32"` | `"ESP8266"` | `"STM32"`).
    pub manufacturer: String,
    /// Friendly chip name (`"ESP32-S3"`, `"STM32F103"`, …).
    pub chip_name: String,
    /// Flash size in KB if known, else `None`.
    pub flash_size_kb: Option<u32>,
    /// Original chip-info struct so per-driver UIs can render extra fields.
    pub extra: Value,
}

impl From<Detected> for DetectedChip {
    fn from(detected: Detected) -> Self {
        let (driver_id, manufacturer, extra) = match &detected {
            Detected::Esp(info) => (
                "esp-uart",
                if info.chip.eq_ignore_ascii_case("esp8266") {
                    "ESP8266"
                } else {
                    "ESP32"
                },
                serde_json::to_value(info),
            ),
            Detected::Stm32(info) => ("stm32-uart", "STM32", serde_json::to_value(info)),
        };
        DetectedChip {
            driver_id: driver_id.to_string(),
            manufacturer: manufacturer.to_string(),
            chip_name: detected.chip_name(),
            flash_size_kb: detected.flash_size_kb(),
            extra: extra.unwrap_or(Value::Null),
        }
    }
}

/// Cancellation registry — flasher tasks check this flag periodically.
static CANCEL_FLAGS: Lazy<Mutex<std::collections::HashMap<String, bool>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

pub(crate) fn register_flash(flash_id: &str) {
    let mut flags = CANCEL_FLAGS.lock().unwrap();
    flags.insert(flash_id.to_string(), false);
}

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

/// Every event carries the last byte counts, because the UI takes its
/// progress bar from whichever event arrived last.
struct TauriSink {
    app: AppHandle,
    flash_id: String,
    phase: FlashPhase,
    bytes_done: u64,
    bytes_total: u64,
}

impl TauriSink {
    fn emit(&self, message: Option<&str>) {
        emit_progress(
            &self.app,
            FlasherProgress {
                flash_id: self.flash_id.clone(),
                phase: self.phase,
                bytes_done: self.bytes_done,
                bytes_total: self.bytes_total,
                message: message.map(str::to_string),
            },
        );
    }
}

impl FlashProgress for TauriSink {
    fn on_progress(&mut self, message: &str) {
        self.emit(Some(message));
    }

    fn on_stage(&mut self, stage: FlashStage, message: &str) {
        self.phase = stage.into();
        self.emit(Some(message));
    }

    fn on_bytes(&mut self, done: u64, total: u64) {
        self.bytes_done = done;
        self.bytes_total = total;
        self.emit(None);
    }

    fn cancelled(&self) -> bool {
        is_cancelled(&self.flash_id)
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, FlashError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Flasher task panicked: {e}"))?
        .map_err(|e| e.to_string())
}

/// Runs `op` on the blocking pool under a fresh flash id, reporting through
/// `flasher-progress`; returns the id at once.
fn spawn_flash<F>(app: AppHandle, prefix: &str, op: F) -> String
where
    F: FnOnce(&mut TauriSink) -> Result<(), FlashError> + Send + 'static,
{
    let flash_id = new_flash_id(prefix);
    register_flash(&flash_id);
    let mut sink = TauriSink {
        app: app.clone(),
        flash_id: flash_id.clone(),
        phase: FlashPhase::Connecting,
        bytes_done: 0,
        bytes_total: 0,
    };
    let id = flash_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = blocking(move || op(&mut sink)).await;
        finalise_flash_result(&app, &id, result);
    });
    flash_id
}

// ============================================================================
// Tauri commands — ESP32
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_detect_chip(
    port: String,
    options: Option<EspFlashOptions>,
) -> Result<EspChipInfo, String> {
    let opts = options.unwrap_or_default();
    blocking(move || esp::detect_chip(&port, &opts.parse()?)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_flash(
    app: AppHandle,
    port: String,
    image_path: String,
    address: u32,
    options: Option<EspFlashOptions>,
) -> Result<String, String> {
    let opts = options.unwrap_or_default();
    Ok(spawn_flash(app, "esp", move |sink| {
        esp::flash(&port, image_path.as_ref(), address, &opts.parse()?, sink)
    }))
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
    let opts = options.unwrap_or_default();
    Ok(spawn_flash(app, "esp", move |sink| {
        esp::read_flash(
            &port,
            output_path.as_ref(),
            offset,
            size,
            &opts.parse()?,
            sink,
        )
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_esp_erase(
    app: AppHandle,
    port: String,
    options: Option<EspFlashOptions>,
) -> Result<String, String> {
    let opts = options.unwrap_or_default();
    Ok(spawn_flash(app, "esp", move |sink| {
        esp::erase(&port, &opts.parse()?, sink)
    }))
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
    blocking(dfu::list_devices).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_dfu_flash(
    app: AppHandle,
    usb_serial: String,
    image_path: String,
    address: u32,
) -> Result<String, String> {
    Ok(spawn_flash(app, "dfu", move |sink| {
        dfu::flash(&usb_serial, image_path.as_ref(), address, sink)
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_dfu_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

// ============================================================================
// Tauri commands — STM32 UART (AN3155 system bootloader)
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_stm32_detect_chip(
    port: String,
    options: Option<Stm32FlashOptions>,
) -> Result<Stm32ChipInfo, String> {
    let opts = Stm32UartOptions::from(&options.unwrap_or_default());
    blocking(move || stm32_uart::detect_chip(&port, &opts)).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_stm32_flash(
    app: AppHandle,
    port: String,
    image_path: String,
    address: u32,
    options: Option<Stm32FlashOptions>,
) -> Result<String, String> {
    let opts = Stm32UartOptions::from(&options.unwrap_or_default());
    Ok(spawn_flash(app, "stm32", move |sink| {
        stm32_uart::flash(&port, image_path.as_ref(), address, &opts, sink)
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_stm32_read_flash(
    app: AppHandle,
    port: String,
    output_path: String,
    offset: u32,
    size: Option<u32>,
    options: Option<Stm32FlashOptions>,
) -> Result<String, String> {
    let opts = Stm32UartOptions::from(&options.unwrap_or_default());
    Ok(spawn_flash(app, "stm32", move |sink| {
        stm32_uart::read_flash(&port, output_path.as_ref(), offset, size, &opts, sink)
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_stm32_erase(
    app: AppHandle,
    port: String,
    options: Option<Stm32FlashOptions>,
) -> Result<String, String> {
    let opts = Stm32UartOptions::from(&options.unwrap_or_default());
    Ok(spawn_flash(app, "stm32", move |sink| {
        stm32_uart::erase(&port, &opts, sink)
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub fn flasher_stm32_cancel(flash_id: String) -> Result<(), String> {
    request_cancel(&flash_id);
    Ok(())
}

// ============================================================================
// Tauri command — unified chip-family detection
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn flasher_serial_detect(
    port: String,
    stm32_options: Option<Stm32FlashOptions>,
) -> Result<DetectedChip, String> {
    let opts = Stm32UartOptions::from(&stm32_options.unwrap_or_default());
    blocking(move || wslib_mcu_flash::detect::detect(&port, &opts))
        .await
        .map(DetectedChip::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detected_esp_serialises_as_before() {
        let detected = DetectedChip::from(Detected::Esp(EspChipInfo {
            chip: "esp32s3".into(),
            features: vec!["WiFi".into()],
            mac: "aa:bb".into(),
            flash_size_bytes: Some(8 * 1024 * 1024),
        }));
        assert_eq!(
            serde_json::to_value(detected).unwrap(),
            json!({
                "driver_id": "esp-uart",
                "manufacturer": "ESP32",
                "chip_name": "ESP32-S3",
                "flash_size_kb": 8192,
                "extra": {
                    "chip": "esp32s3",
                    "features": ["WiFi"],
                    "mac": "aa:bb",
                    "flash_size_bytes": 8388608u64,
                },
            })
        );
    }

    #[test]
    fn detected_esp8266_takes_its_own_badge() {
        let detected = DetectedChip::from(Detected::Esp(EspChipInfo {
            chip: "esp8266".into(),
            features: vec![],
            mac: "aa".into(),
            flash_size_bytes: None,
        }));
        assert_eq!(detected.manufacturer, "ESP8266");
        assert_eq!(detected.chip_name, "ESP8266");
    }

    #[test]
    fn detected_stm32_serialises_as_before() {
        let detected = DetectedChip::from(Detected::Stm32(Stm32ChipInfo {
            chip: "STM32F1 medium-density".into(),
            pid: 0x410,
            bootloader_version: "2.2".into(),
            flash_size_kb: Some(128),
            rdp_level: Some("0".into()),
        }));
        assert_eq!(
            serde_json::to_value(detected).unwrap(),
            json!({
                "driver_id": "stm32-uart",
                "manufacturer": "STM32",
                "chip_name": "STM32F1 medium-density",
                "flash_size_kb": 128,
                "extra": {
                    "chip": "STM32F1 medium-density",
                    "pid": 0x410,
                    "bootloader_version": "2.2",
                    "flash_size_kb": 128,
                    "rdp_level": "0",
                },
            })
        );
    }

    #[test]
    fn unset_stm32_options_are_stm32flash_wiring() {
        assert_eq!(
            Stm32UartOptions::from(&Stm32FlashOptions::default()),
            Stm32UartOptions::default()
        );
    }

    #[test]
    fn resetting_reports_as_verifying() {
        assert!(matches!(
            FlashPhase::from(FlashStage::Resetting),
            FlashPhase::Verifying
        ));
    }

    #[test]
    fn bad_esp_option_names_the_value() {
        let opts = EspFlashOptions {
            flash_mode: Some("spi".into()),
            ..Default::default()
        };
        assert!(opts.parse().unwrap_err().to_string().contains("spi"));
    }
}

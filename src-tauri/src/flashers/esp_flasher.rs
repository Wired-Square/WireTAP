//! ESP32-family firmware flasher.
//!
//! Wraps the `espflash` crate to drive the Espressif serial bootloader. The
//! happy path:
//!
//! 1. Open the serial port at the requested baud (espflash will toggle
//!    DTR/RTS to enter download mode).
//! 2. Detect the chip and report it back to the UI.
//! 3. Read the firmware image from disk.
//! 4. Stream it to flash, emitting `FlasherProgress` on every chunk.
//!
//! Cancellation: callers set a flag via `super::request_cancel`; the flash
//! loop checks `super::is_cancelled` between chunks.
//!
//! NOTE: The real flash loop here is a stub that returns an error. The
//! frontend, command surface, progress channel, and cancellation are all
//! wired and ready — drop in `espflash::Flasher::connect(...)` plus
//! `write_bin_to_flash(...)` against real hardware to finish the job.

use tauri::AppHandle;

use super::{emit_progress, EspChipInfo, FlashPhase, FlasherProgress};

pub async fn detect_chip(_port: String, _baud: u32) -> Result<EspChipInfo, String> {
    // TODO: wire up `espflash::flasher::Flasher::connect` and call
    // `flasher.chip()` / `flasher.device_info()`. Returning a clear error
    // until that's done with a real ESP32 to verify against.
    Err("ESP32 chip detection is not yet wired up — see src-tauri/src/flashers/esp_flasher.rs".to_string())
}

pub async fn flash(
    app: AppHandle,
    flash_id: String,
    _port: String,
    _baud: u32,
    image_path: String,
    _address: u32,
) -> Result<(), String> {
    // Surface that we got as far as opening the request, so the UI shows
    // the connecting phase even on the stub.
    emit_progress(
        &app,
        FlasherProgress {
            flash_id: flash_id.clone(),
            phase: FlashPhase::Connecting,
            bytes_done: 0,
            bytes_total: 0,
            message: Some(format!("Would flash {image_path}")),
        },
    );
    Err(
        "ESP32 flashing is not yet wired up. The Serial app's frontend, command \
         surface, progress events, and cancellation are ready — wire \
         `espflash::flasher::Flasher::connect` + `write_bin_to_flash` here."
            .to_string(),
    )
}

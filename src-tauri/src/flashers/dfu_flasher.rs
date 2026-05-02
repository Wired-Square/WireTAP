//! STM32 USB DFU 1.1 / DfuSe flasher.
//!
//! Wraps `dfu-nusb` (which builds on `dfu-core`) to talk the standard DFU
//! protocol to STM32 chips that have been booted into bootloader mode
//! (BOOT0 high + reset). Independent of the serial port.
//!
//! NOTE: The real device enumeration + flash loop here is a stub returning
//! an error. The Tauri commands and progress channel are wired; drop in
//! `nusb::list_devices().filter(...)` for enumeration and
//! `dfu_nusb::DfuSync::open(...).download(...)` for the flash loop, with
//! progress callbacks that emit `FlasherProgress`.

use tauri::AppHandle;

use super::{emit_progress, DfuDeviceInfo, FlashPhase, FlasherProgress};

pub async fn list_devices() -> Result<Vec<DfuDeviceInfo>, String> {
    // TODO: enumerate via `nusb::list_devices()` and filter on the DFU class
    // descriptor (interface class 0xFE, subclass 0x01).
    Ok(vec![])
}

pub async fn flash(
    app: AppHandle,
    flash_id: String,
    _usb_serial: String,
    image_path: String,
    _address: u32,
) -> Result<(), String> {
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
        "STM32 DFU flashing is not yet wired up. The Serial app's frontend, command \
         surface, progress events, and cancellation are ready — wire \
         `dfu_nusb::DfuSync::open` + `download` here."
            .to_string(),
    )
}

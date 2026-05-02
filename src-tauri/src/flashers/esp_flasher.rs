//! ESP32-family firmware flasher.
//!
//! Wraps the `espflash` crate to drive the Espressif serial bootloader.
//! Operations exposed to the front-end:
//!
//! * `detect_chip` — open the port, talk to the bootloader, return the chip
//!   model, MAC, and detected flash size. Used by the auto-detect that runs
//!   when the user enters the ESP Flash tab.
//! * `flash` — write a raw `.bin` to flash at a given address. If writing
//!   to address 0x0 the bootloader header (bytes 2-3) is patched with the
//!   user's flash mode/freq/size, mirroring `esptool write-flash`.
//! * `read_flash` — read a region (or the whole chip) back to a file,
//!   chunked so the UI gets a smooth progress bar and so we can honour
//!   cancellation between chunks.
//! * `erase` — erase the entire flash chip (`esptool erase-flash`).
//!
//! Everything that touches the serial port is synchronous in `espflash`, so
//! each operation runs inside `spawn_blocking` to keep the Tauri runtime
//! responsive. Cancellation is co-operative — long loops poll
//! `super::is_cancelled` between chunks.

use std::str::FromStr;
use std::time::Duration;

use espflash::command::{Command, CommandType};
use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::{
    FlashFrequency,
    FlashMode,
    FlashSize,
    Flasher,
};
use espflash::target::{Chip, ProgressCallbacks};
use serialport::{SerialPortType, UsbPortInfo};
use tauri::AppHandle;

use super::{
    emit_progress,
    is_cancelled,
    EspChipInfo,
    EspFlashOptions,
    FlashPhase,
    FlasherProgress,
};

const DEFAULT_FLASH_BAUD: u32 = 921_600;
const READ_CHUNK_SIZE: u32 = 64 * 1024;
const READ_BLOCK_SIZE: u32 = 1024;
const READ_MAX_IN_FLIGHT: u32 = 64;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

pub async fn detect_chip(
    port: String,
    options: EspFlashOptions,
) -> Result<EspChipInfo, String> {
    blocking(move || {
        let mut flasher = open_flasher(&port, &options)?;
        chip_info_from(&mut flasher)
    })
    .await
}

pub async fn flash(
    app: AppHandle,
    flash_id: String,
    port: String,
    image_path: String,
    address: u32,
    options: EspFlashOptions,
) -> Result<(), String> {
    let app_for_progress = app.clone();
    let flash_id_for_progress = flash_id.clone();

    blocking(move || {
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Connecting,
            0,
            0,
            Some(format!("Opening {port}")),
        );

        let mut flasher = open_flasher(&port, &options)?;

        // Surface the connected chip in the log so the user can sanity-check.
        if let Ok(info) = chip_info_from(&mut flasher) {
            emit(
                &app_for_progress,
                &flash_id_for_progress,
                FlashPhase::Connecting,
                0,
                0,
                Some(format!(
                    "Connected: {} · MAC {} · {}",
                    info.chip,
                    info.mac,
                    info.flash_size_bytes
                        .map(|b| format!("{} MB flash", b / (1024 * 1024)))
                        .unwrap_or_else(|| "flash size unknown".to_string()),
                )),
            );
        }

        // Apply flash size to the in-memory bootloader view (affects boundary
        // checks during the write). Mode + freq are baked into the image
        // header instead — see `patch_image_header`.
        if let Some(size) = parse_flash_size(options.flash_size.as_deref())? {
            flasher.set_flash_size(size);
        }

        let mut buffer = std::fs::read(&image_path)
            .map_err(|e| format!("Failed to read {image_path}: {e}"))?;

        // Mirror esptool: patch flash mode/freq/size into the bootloader
        // image header at offset 0x0 when the user has overridden any of them.
        if address == 0x0 {
            if let Some(notes) =
                patch_image_header(&mut buffer, &options, flasher.chip())?
            {
                emit(
                    &app_for_progress,
                    &flash_id_for_progress,
                    FlashPhase::Connecting,
                    0,
                    0,
                    Some(format!("Patched image header: {notes}")),
                );
            }
        }

        check_cancel(&flash_id_for_progress)?;

        let total = buffer.len() as u64;
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Writing,
            0,
            total,
            Some(format!("Writing {} bytes to 0x{:x}", total, address)),
        );

        let mut progress = TauriProgress::new(
            app_for_progress.clone(),
            flash_id_for_progress.clone(),
            FlashPhase::Writing,
            address,
            total,
        );

        flasher
            .write_bin_to_flash(address, &buffer, &mut progress)
            .map_err(|e| format!("Flash write failed: {e}"))?;

        check_cancel(&flash_id_for_progress)?;

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Verifying,
            total,
            total,
            Some("Flash complete; chip will reset".to_string()),
        );

        Ok(())
    })
    .await
}

pub async fn read_flash(
    app: AppHandle,
    flash_id: String,
    port: String,
    output_path: String,
    offset: u32,
    size: Option<u32>,
    options: EspFlashOptions,
) -> Result<(), String> {
    let app_for_progress = app.clone();
    let flash_id_for_progress = flash_id.clone();

    blocking(move || {
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Connecting,
            0,
            0,
            Some(format!("Opening {port}")),
        );

        let mut flasher = open_flasher(&port, &options)?;

        // If size was not given, dump the full chip.
        let resolved_size = match size {
            Some(s) => s,
            None => match flasher.flash_detect().ok().flatten() {
                Some(detected) => detected.size(),
                None => {
                    return Err(
                        "Could not auto-detect flash size; specify size or pick one from the form"
                            .to_string(),
                    );
                }
            },
        };

        let total = resolved_size as u64;
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Writing,
            0,
            total,
            Some(format!(
                "Reading {} bytes from 0x{:x} to {}",
                total, offset, output_path
            )),
        );

        // Chunked read so we get progress + cancellation. espflash's own
        // read_flash() truncates the file each call, so we drive the
        // bootloader directly via Connection commands and append.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .create(true)
            .open(&output_path)
            .map_err(|e| format!("Failed to open {output_path}: {e}"))?;

        let mut bytes_done: u64 = 0;
        let mut current_offset = offset;
        let mut remaining = resolved_size;

        while remaining > 0 {
            check_cancel(&flash_id_for_progress)?;

            let chunk_size = remaining.min(READ_CHUNK_SIZE);
            let chunk = read_chunk(
                flasher.connection(),
                current_offset,
                chunk_size,
                READ_BLOCK_SIZE.min(chunk_size),
                READ_MAX_IN_FLIGHT,
            )?;

            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write {output_path}: {e}"))?;

            bytes_done += chunk.len() as u64;
            current_offset = current_offset.saturating_add(chunk.len() as u32);
            remaining = remaining.saturating_sub(chunk.len() as u32);

            emit(
                &app_for_progress,
                &flash_id_for_progress,
                FlashPhase::Writing,
                bytes_done,
                total,
                None,
            );
        }

        file.sync_all().ok();

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Writing,
            total,
            total,
            Some(format!("Saved {} bytes to {}", total, output_path)),
        );

        Ok(())
    })
    .await
}

pub async fn erase(
    app: AppHandle,
    flash_id: String,
    port: String,
    options: EspFlashOptions,
) -> Result<(), String> {
    let app_for_progress = app.clone();
    let flash_id_for_progress = flash_id.clone();

    blocking(move || {
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Connecting,
            0,
            0,
            Some(format!("Opening {port}")),
        );

        let mut flasher = open_flasher(&port, &options)?;

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Erasing,
            0,
            0,
            Some("Erasing entire flash — this can take a minute…".to_string()),
        );

        flasher
            .erase_flash()
            .map_err(|e| format!("Erase failed: {e}"))?;

        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

fn open_flasher(port: &str, options: &EspFlashOptions) -> Result<Flasher, String> {
    let chip_override = parse_chip(options.chip.as_deref())?;
    let target_baud = options.flash_baud.unwrap_or(DEFAULT_FLASH_BAUD);

    // The bootloader handshake always happens at 115_200; espflash bumps the
    // baud rate to `target_baud` after sync.
    let serial = serialport::new(port, 115_200)
        .timeout(Duration::from_millis(3_000))
        .open_native()
        .map_err(|e| format!("Failed to open serial port {port}: {e}"))?;

    let port_info = lookup_usb_port_info(port);

    let connection = Connection::new(
        serial,
        port_info,
        ResetAfterOperation::HardReset,
        ResetBeforeOperation::DefaultReset,
        target_baud,
    );

    Flasher::connect(
        connection,
        true,  // use_stub
        false, // verify
        false, // skip
        chip_override,
        Some(target_baud),
    )
    .map_err(|e| format!("Bootloader handshake failed: {e}"))
}

fn lookup_usb_port_info(port: &str) -> UsbPortInfo {
    if let Ok(ports) = serialport::available_ports() {
        for info in ports {
            if info.port_name == port {
                if let SerialPortType::UsbPort(usb) = info.port_type {
                    return usb;
                }
            }
        }
    }
    UsbPortInfo {
        vid: 0,
        pid: 0,
        serial_number: None,
        manufacturer: None,
        product: None,
    }
}

fn chip_info_from(flasher: &mut Flasher) -> Result<EspChipInfo, String> {
    let info = flasher
        .device_info()
        .map_err(|e| format!("Failed to read chip info: {e}"))?;
    let mac = info
        .mac_address
        .clone()
        .unwrap_or_else(|| "(unknown)".to_string());
    Ok(EspChipInfo {
        chip: info.chip.to_string(),
        features: info.features.clone(),
        mac,
        flash_size_bytes: Some(info.flash_size.size() as u64),
    })
}

// ---------------------------------------------------------------------------
// Image header patching (mirrors `esptool write-flash --flash-mode/freq/size`)
// ---------------------------------------------------------------------------

const ESP_IMAGE_MAGIC: u8 = 0xE9;

fn patch_image_header(
    buffer: &mut [u8],
    options: &EspFlashOptions,
    chip: Chip,
) -> Result<Option<String>, String> {
    if buffer.len() < 4 || buffer[0] != ESP_IMAGE_MAGIC {
        return Ok(None);
    }

    let mut notes: Vec<String> = Vec::new();

    if let Some(mode) = parse_flash_mode(options.flash_mode.as_deref())? {
        buffer[2] = mode as u8;
        notes.push(format!("mode={:?}", mode));
    }

    let size = parse_flash_size(options.flash_size.as_deref())?;
    let freq = parse_flash_freq(options.flash_freq.as_deref())?;

    if size.is_some() || freq.is_some() {
        let existing = buffer[3];
        let mut size_nibble = (existing >> 4) & 0x0F;
        let mut freq_nibble = existing & 0x0F;

        if let Some(size) = size {
            size_nibble = size
                .encode_flash_size()
                .map_err(|e| format!("Unsupported flash size: {e}"))?;
            notes.push(format!("size={:?}", size));
        }
        if let Some(freq) = freq {
            freq_nibble = freq
                .encode_flash_frequency(chip)
                .map_err(|e| format!("Unsupported flash freq: {e}"))?;
            notes.push(format!("freq={:?}", freq));
        }

        buffer[3] = (size_nibble << 4) | (freq_nibble & 0x0F);
    }

    if notes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(notes.join(", ")))
    }
}

// ---------------------------------------------------------------------------
// Chunked flash read (drives Connection directly so we can emit progress)
// ---------------------------------------------------------------------------

fn read_chunk(
    connection: &mut Connection,
    offset: u32,
    size: u32,
    block_size: u32,
    max_in_flight: u32,
) -> Result<Vec<u8>, String> {
    connection
        .with_timeout(CommandType::ReadFlash.timeout(), |c| {
            c.command(Command::ReadFlash {
                offset,
                size,
                block_size,
                max_in_flight,
            })
        })
        .map_err(|e| format!("ReadFlash command failed: {e}"))?;

    let mut data: Vec<u8> = Vec::with_capacity(size as usize);
    while data.len() < size as usize {
        let response = connection
            .read_flash_response()
            .map_err(|e| format!("Flash read response failed: {e}"))?;
        let chunk: Vec<u8> = match response {
            Some(r) => r
                .value
                .try_into()
                .map_err(|e| format!("Bad flash chunk response: {e}"))?,
            None => return Err("No response while reading flash".to_string()),
        };
        data.extend_from_slice(&chunk);
        if data.len() < size as usize && (chunk.len() as u32) < block_size {
            return Err(format!(
                "Truncated flash read: got {} of {} bytes",
                data.len(),
                size
            ));
        }
        connection
            .write_raw(data.len() as u32)
            .map_err(|e| format!("Flash read ack failed: {e}"))?;
    }

    // The bootloader follows up with an MD5 digest — drain it so the next
    // command stays in sync, but don't fail the operation if it's missing.
    let _ = connection.read_flash_response();

    Ok(data)
}

// ---------------------------------------------------------------------------
// Progress + cancellation glue
// ---------------------------------------------------------------------------

struct TauriProgress {
    app: AppHandle,
    flash_id: String,
    phase: FlashPhase,
    addr: u32,
    total: u64,
}

impl TauriProgress {
    fn new(
        app: AppHandle,
        flash_id: String,
        phase: FlashPhase,
        addr: u32,
        total: u64,
    ) -> Self {
        Self {
            app,
            flash_id,
            phase,
            addr,
            total,
        }
    }
}

impl ProgressCallbacks for TauriProgress {
    fn init(&mut self, addr: u32, total: usize) {
        self.addr = addr;
        self.total = total as u64;
        emit(
            &self.app,
            &self.flash_id,
            self.phase.clone(),
            0,
            self.total,
            None,
        );
    }

    fn update(&mut self, current: usize) {
        emit(
            &self.app,
            &self.flash_id,
            self.phase.clone(),
            current as u64,
            self.total,
            None,
        );
    }

    fn verifying(&mut self) {
        emit(
            &self.app,
            &self.flash_id,
            FlashPhase::Verifying,
            self.total,
            self.total,
            Some("Verifying…".to_string()),
        );
    }

    fn finish(&mut self, _skipped: bool) {
        emit(
            &self.app,
            &self.flash_id,
            self.phase.clone(),
            self.total,
            self.total,
            None,
        );
    }
}

fn emit(
    app: &AppHandle,
    flash_id: &str,
    phase: FlashPhase,
    bytes_done: u64,
    bytes_total: u64,
    message: Option<String>,
) {
    emit_progress(
        app,
        FlasherProgress {
            flash_id: flash_id.to_string(),
            phase,
            bytes_done,
            bytes_total,
            message,
        },
    );
}

fn check_cancel(flash_id: &str) -> Result<(), String> {
    if is_cancelled(flash_id) {
        Err("Cancelled by user".to_string())
    } else {
        Ok(())
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Flasher task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

fn parse_chip(s: Option<&str>) -> Result<Option<Chip>, String> {
    let Some(raw) = s else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let normalised = trimmed.to_ascii_lowercase();
    Chip::from_str(&normalised)
        .map(Some)
        .map_err(|e| format!("Unknown chip {raw:?}: {e}"))
}

fn parse_flash_mode(s: Option<&str>) -> Result<Option<FlashMode>, String> {
    let Some(raw) = s else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let mode = match trimmed.to_ascii_lowercase().as_str() {
        "qio" => FlashMode::Qio,
        "qout" => FlashMode::Qout,
        "dio" => FlashMode::Dio,
        "dout" => FlashMode::Dout,
        other => return Err(format!("Unknown flash mode {other:?}")),
    };
    Ok(Some(mode))
}

fn parse_flash_size(s: Option<&str>) -> Result<Option<FlashSize>, String> {
    let Some(raw) = s else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    FlashSize::from_str(trimmed)
        .map(Some)
        .map_err(|e| format!("Unknown flash size {raw:?}: {e}"))
}

fn parse_flash_freq(s: Option<&str>) -> Result<Option<FlashFrequency>, String> {
    let Some(raw) = s else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return Ok(None);
    }
    let freq = match trimmed
        .to_ascii_lowercase()
        .trim_end_matches("hz")
        .trim_end_matches('m')
    {
        "12" => FlashFrequency::_12Mhz,
        "15" => FlashFrequency::_15Mhz,
        "16" => FlashFrequency::_16Mhz,
        "20" => FlashFrequency::_20Mhz,
        "24" => FlashFrequency::_24Mhz,
        "26" => FlashFrequency::_26Mhz,
        "30" => FlashFrequency::_30Mhz,
        "40" => FlashFrequency::_40Mhz,
        "48" => FlashFrequency::_48Mhz,
        "60" => FlashFrequency::_60Mhz,
        "80" => FlashFrequency::_80Mhz,
        other => return Err(format!("Unknown flash freq {other:?}")),
    };
    Ok(Some(freq))
}

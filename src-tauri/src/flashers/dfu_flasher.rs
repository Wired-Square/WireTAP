//! STM32 USB DFU 1.1 / DfuSe flasher.
//!
//! Wraps `dfu-nusb` (which builds on `dfu-core`) to talk the standard DFU
//! protocol to chips that have been booted into bootloader mode (BOOT0 high
//! + reset on STM32; vendor-specific everywhere else). Independent of the
//! serial port — DFU runs over raw USB control transfers.
//!
//! `dfu-core` auto-detects DfuSe (ST's extension that adds
//! SET_ADDRESS_POINTER + ERASE_PAGE) by inspecting the bootloader's
//! interface alt-string memory layout, so a single `download()` call works
//! for both vanilla DFU 1.1 and DfuSe flash regions.
//!
//! Cancellation: `dfu_core::sync::DfuSync::download` is one blocking call,
//! so we abort by triggering `nusb::Device::reset()` on a cloned handle
//! from inside the progress callback when the cancel flag is set. The
//! in-flight control transfer fails on the next chunk.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nusb_dfu as nusb;
use tauri::AppHandle;

use super::{
    emit_progress,
    is_cancelled,
    DfuDeviceInfo,
    FlashPhase,
    FlasherProgress,
};

// USB DFU runtime/bootloader interface class + subclass per DFU 1.1 spec.
const DFU_INTERFACE_CLASS: u8 = 0xFE;
const DFU_INTERFACE_SUBCLASS: u8 = 0x01;

// STM32 system bootloader (the one users typically flash via DFU).
const STM32_DFU_VID: u16 = 0x0483;
const STM32_DFU_PID: u16 = 0xDF11;
// STM32 system bootloader uses DfuSe with internal flash starting here.
const STM32_DEFAULT_FLASH_BASE: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

pub async fn list_devices() -> Result<Vec<DfuDeviceInfo>, String> {
    blocking(|| {
        let iter =
            nusb::list_devices().map_err(|e| format!("Failed to enumerate USB: {e}"))?;
        let mut out = Vec::new();
        for info in iter {
            if !is_dfu(&info) {
                continue;
            }
            out.push(DfuDeviceInfo {
                vid: info.vendor_id(),
                pid: info.product_id(),
                serial: info
                    .serial_number()
                    .map(|s| s.to_string())
                    // DFU devices without a serial fall back to bus/addr — not
                    // stable across reconnects but distinguishes peers in a
                    // single enumeration.
                    .unwrap_or_else(|| {
                        format!("bus{}-dev{}", info.bus_number(), info.device_address())
                    }),
                display_name: friendly_name(&info),
            });
        }
        Ok(out)
    })
    .await
}

pub async fn flash(
    app: AppHandle,
    flash_id: String,
    usb_serial: String,
    image_path: String,
    address: u32,
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
            Some(format!("Locating DFU device {usb_serial}")),
        );

        // Find the device. We accept either a real serial number or our
        // fallback `bus<N>-dev<M>` synthetic identifier.
        let info = nusb::list_devices()
            .map_err(|e| format!("Failed to enumerate USB: {e}"))?
            .find(|d| matches_identifier(d, &usb_serial))
            .ok_or_else(|| {
                format!("DFU device {usb_serial} not found — is it still in bootloader mode?")
            })?;

        let vid = info.vendor_id();
        let pid = info.product_id();
        let display = friendly_name(&info);
        let interface_number = pick_dfu_interface(&info)
            .ok_or_else(|| "DFU interface not advertised on this device".to_string())?;

        let device = info
            .open()
            .map_err(|e| format!("Failed to open USB device: {e}"))?;

        // Keep a clone of the device for the cancellation path — when the
        // user hits Cancel we trigger `reset()` here from the progress
        // callback, which fails the in-flight DFU control transfer.
        let cancel_device = device.clone();

        let interface = device
            .claim_interface(interface_number)
            .map_err(|e| format!("Failed to claim DFU interface {interface_number}: {e}"))?;

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Connecting,
            0,
            0,
            Some(format!(
                "Connected: {display} ({:04x}:{:04x})",
                vid, pid
            )),
        );

        let dfu_io = dfu_nusb::DfuNusb::open(device, interface, 0)
            .map_err(|e| format!("DFU handshake failed: {e}"))?;
        let mut dfu = dfu_io.into_sync_dfu();
        dfu.override_address(address);

        // Parse the image. .bin → raw, .hex → coalesced to a single span,
        // .dfu → strip suffix (and DfuSe prefix if present).
        let image_bytes = parse_image(&image_path)?;
        let total = image_bytes.len();
        if total == 0 {
            return Err("Firmware image is empty".to_string());
        }

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Erasing,
            0,
            total as u64,
            Some(format!(
                "Programming {total} bytes to 0x{address:08X} (DFU will erase as needed)",
            )),
        );

        // Progress closure: accumulate, emit, and trigger device reset on
        // cancel. We use `cancelled_handled` so we only fire `reset()` once
        // — subsequent progress callbacks just stop emitting.
        let app_for_cb = app_for_progress.clone();
        let flash_id_for_cb = flash_id_for_progress.clone();
        let acc = Arc::new(AtomicUsize::new(0));
        let cancelled_handled = Arc::new(AtomicBool::new(false));
        {
            let acc = acc.clone();
            let cancelled_handled = cancelled_handled.clone();
            dfu.with_progress(move |n| {
                let cur = acc.fetch_add(n, Ordering::Relaxed) + n;
                emit(
                    &app_for_cb,
                    &flash_id_for_cb,
                    FlashPhase::Writing,
                    cur as u64,
                    total as u64,
                    None,
                );
                if is_cancelled(&flash_id_for_cb)
                    && !cancelled_handled.swap(true, Ordering::Relaxed)
                {
                    emit(
                        &app_for_cb,
                        &flash_id_for_cb,
                        FlashPhase::Writing,
                        cur as u64,
                        total as u64,
                        Some("Cancellation requested — resetting device…".to_string()),
                    );
                    let _ = cancel_device.reset();
                }
            });
        }

        dfu.download(Cursor::new(&image_bytes), total as u32)
            .map_err(|e| {
                if is_cancelled(&flash_id_for_progress) {
                    format!("Cancelled by user: {e}")
                } else {
                    format!("DFU download failed: {e}")
                }
            })?;

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Verifying,
            total as u64,
            total as u64,
            Some("Download complete; detaching to start firmware".to_string()),
        );

        // Best-effort: tell the device to leave DFU mode and start the new
        // firmware. Some bootloaders accept DFU_DETACH; all of them survive
        // a USB reset, which the spec uses as the universal "exit DFU" trigger.
        let _ = dfu.detach();
        // Tiny delay so the bootloader sees DETACH before the reset arrives.
        std::thread::sleep(Duration::from_millis(50));
        let _ = dfu.usb_reset();

        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Device matching helpers
// ---------------------------------------------------------------------------

/// Match either by USB serial (preferred — stable across reconnect) or by
/// the synthetic `bus<N>-dev<M>` identifier we hand back when the device
/// reports no serial.
fn matches_identifier(info: &nusb::DeviceInfo, identifier: &str) -> bool {
    if let Some(serial) = info.serial_number() {
        if serial == identifier {
            return true;
        }
    }
    let synthetic = format!("bus{}-dev{}", info.bus_number(), info.device_address());
    synthetic == identifier
}

/// True if any interface on this device advertises the DFU class. Handles
/// both runtime DFU (regular product on a DFU-capable interface) and DFU-mode
/// (bootloader exposing only the DFU interface).
fn is_dfu(info: &nusb::DeviceInfo) -> bool {
    info.interfaces().any(is_dfu_interface)
}

fn is_dfu_interface(iface: &nusb::InterfaceInfo) -> bool {
    iface.class() == DFU_INTERFACE_CLASS && iface.subclass() == DFU_INTERFACE_SUBCLASS
}

/// Return the interface number of the first DFU-class interface, or `None`
/// if there isn't one. STM32 bootloaders only expose interface 0; runtime
/// devices may bury DFU on a higher index.
fn pick_dfu_interface(info: &nusb::DeviceInfo) -> Option<u8> {
    info.interfaces()
        .find(|i| is_dfu_interface(i))
        .map(|i| i.interface_number())
}

/// Friendly device label for the picker. Prefers product/manufacturer
/// strings; falls back to a hard-coded label for the well-known STM32 PID,
/// then to the bare VID:PID.
fn friendly_name(info: &nusb::DeviceInfo) -> String {
    let manufacturer = info.manufacturer_string().map(str::trim).filter(|s| !s.is_empty());
    let product = info.product_string().map(str::trim).filter(|s| !s.is_empty());
    match (manufacturer, product) {
        (Some(m), Some(p)) => format!("{m} {p}"),
        (Some(m), None) => m.to_string(),
        (None, Some(p)) => p.to_string(),
        (None, None) => {
            if info.vendor_id() == STM32_DFU_VID && info.product_id() == STM32_DFU_PID {
                "STM32 Bootloader".to_string()
            } else {
                format!(
                    "USB DFU {:04x}:{:04x}",
                    info.vendor_id(),
                    info.product_id()
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Image parsing
// ---------------------------------------------------------------------------

/// Parse the user-supplied firmware file into raw bytes ready for
/// `DfuSync::download`.
///
/// - `.bin` — raw, returned as-is.
/// - `.hex` — Intel HEX parsed via the `ihex` crate; coalesced to a single
///   contiguous span. Multi-span hex files (rare for STM32 application
///   firmware) get the first span; that's enough for typical bootloader
///   builds, and a future revision can split by region.
/// - `.dfu` — strip the trailing 16-byte DFU suffix; if a DfuSe prefix is
///   present, extract the first target's first element's image data.
fn parse_image(path: &str) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".hex") {
        return parse_intel_hex_first_span(&bytes);
    }
    if lower.ends_with(".dfu") {
        return parse_dfu_file(&bytes);
    }
    Ok(bytes)
}

fn parse_intel_hex_first_span(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use ihex::Record;
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("Intel HEX file is not valid UTF-8: {e}"))?;

    let mut upper: u32 = 0;
    // (start_address, contiguous bytes); first entry wins.
    let mut current: Option<(u32, Vec<u8>)> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let record = Record::from_record_string(trimmed)
            .map_err(|e| format!("Intel HEX parse error: {e}"))?;
        match record {
            Record::Data { offset, value } => {
                let addr = upper.wrapping_add(offset as u32);
                match &mut current {
                    None => current = Some((addr, value)),
                    Some((start, data)) => {
                        if start.wrapping_add(data.len() as u32) == addr {
                            data.extend_from_slice(&value);
                        } else {
                            // Non-contiguous — stop coalescing. DFU only
                            // takes one continuous span anyway.
                            break;
                        }
                    }
                }
            }
            Record::ExtendedLinearAddress(u) => upper = (u as u32) << 16,
            Record::ExtendedSegmentAddress(s) => upper = (s as u32) << 4,
            Record::EndOfFile
            | Record::StartLinearAddress(_)
            | Record::StartSegmentAddress { .. } => {}
        }
    }

    let (_, data) =
        current.ok_or_else(|| "Intel HEX file has no data records".to_string())?;
    Ok(data)
}

/// Strip the standard 16-byte DFU suffix from `bytes`. If a DfuSe prefix is
/// present (signature "DfuSe"), return the first target's first element's
/// image data. Otherwise return the prefix-and-suffix-free body.
fn parse_dfu_file(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 16 {
        return Err("DFU file shorter than its 16-byte suffix".to_string());
    }
    // DFU suffix ends with the ASCII 'UFD' magic at offsets 14..16 from end.
    let suffix_start = bytes.len() - 16;
    let signature = &bytes[suffix_start + 8..suffix_start + 11];
    if signature != b"UFD" {
        return Err("DFU file missing 'UFD' suffix signature".to_string());
    }
    let body = &bytes[..suffix_start];

    // DfuSe prefix: 11 bytes of header + per-target descriptors. If we don't
    // see the magic, treat the body as a raw payload (vanilla DFU 1.1 file).
    if body.len() < 11 || &body[0..5] != b"DfuSe" {
        return Ok(body.to_vec());
    }

    parse_dfuse_first_element(body)
}

fn parse_dfuse_first_element(body: &[u8]) -> Result<Vec<u8>, String> {
    // DfuSe prefix layout (little-endian):
    //   0..5   "DfuSe"
    //   5      bVersion (always 0x01)
    //   6..10  DFUImageSize (u32, total size including this prefix)
    //   10     bTargets
    if body.len() < 11 {
        return Err("DfuSe prefix truncated".to_string());
    }
    let num_targets = body[10];
    if num_targets == 0 {
        return Err("DfuSe file has zero targets".to_string());
    }
    let mut cursor = 11;

    // Target prefix layout:
    //   0..6   "Target"
    //   6      bAlternateSetting
    //   7..11  bTargetNamed (u32, only LSB used as bool)
    //   11..266 szTargetName (255 bytes, NUL-padded)
    //   266..270 dwTargetSize (u32)
    //   270..274 dwNbElements (u32)
    if body.len() < cursor + 274 {
        return Err("DfuSe target prefix truncated".to_string());
    }
    if &body[cursor..cursor + 6] != b"Target" {
        return Err("DfuSe target signature missing".to_string());
    }
    let num_elements = u32::from_le_bytes(
        body[cursor + 270..cursor + 274].try_into().unwrap(),
    );
    if num_elements == 0 {
        return Err("DfuSe target has zero image elements".to_string());
    }
    cursor += 274;

    // Element layout:
    //   0..4   dwElementAddress (u32)
    //   4..8   dwElementSize (u32)
    //   8..    Data (dwElementSize bytes)
    if body.len() < cursor + 8 {
        return Err("DfuSe element header truncated".to_string());
    }
    let element_size = u32::from_le_bytes(body[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
    let data_start = cursor + 8;
    let data_end = data_start
        .checked_add(element_size)
        .ok_or_else(|| "DfuSe element size overflow".to_string())?;
    if body.len() < data_end {
        return Err(format!(
            "DfuSe element claims {element_size} bytes but file ends at {}",
            body.len() - data_start
        ));
    }
    Ok(body[data_start..data_end].to_vec())
}

// ---------------------------------------------------------------------------
// Progress glue (mirrors esp_flasher.rs / stm32_flasher.rs)
// ---------------------------------------------------------------------------

#[allow(dead_code)] // reserved for future use; STM32 base is the most common default
const _DEFAULT_BASE: u32 = STM32_DEFAULT_FLASH_BASE;

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

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("DFU flasher task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal vanilla-DFU file: 4 bytes payload + 16-byte suffix ending
    /// with 'UFD'.
    fn make_dfu_no_dfuse(payload: &[u8]) -> Vec<u8> {
        let mut v = payload.to_vec();
        // Suffix: 16 bytes. Layout doesn't matter for our parser beyond the
        // 'UFD' magic at offset 8..11 from start of suffix.
        v.extend_from_slice(&[0; 8]); // bcdDevice/idProduct/idVendor/bcdDFU
        v.extend_from_slice(b"UFD"); // signature
        v.extend_from_slice(&[0; 5]); // bLength + dwCRC
        v
    }

    #[test]
    fn parse_dfu_strips_plain_suffix() {
        let payload = b"\xDE\xAD\xBE\xEF";
        let file = make_dfu_no_dfuse(payload);
        assert_eq!(parse_dfu_file(&file).unwrap(), payload);
    }

    #[test]
    fn parse_dfu_rejects_missing_signature() {
        // 16 bytes, but no 'UFD' at the right spot.
        let bytes = vec![0u8; 16];
        assert!(parse_dfu_file(&bytes).is_err());
    }

    #[test]
    fn parse_dfu_rejects_short_file() {
        assert!(parse_dfu_file(&[0u8; 8]).is_err());
    }

    #[test]
    fn parse_dfuse_first_element_extracts_data() {
        // Build a DfuSe body: prefix + one target + one element with 4 bytes.
        let mut body = Vec::new();
        // DfuSe prefix
        body.extend_from_slice(b"DfuSe");
        body.push(0x01); // version
        body.extend_from_slice(&0u32.to_le_bytes()); // image size (unused by our parser)
        body.push(1); // num targets

        // Target prefix
        body.extend_from_slice(b"Target");
        body.push(0); // alt setting
        body.extend_from_slice(&0u32.to_le_bytes()); // named flag
        body.extend_from_slice(&[0u8; 255]); // name
        body.extend_from_slice(&12u32.to_le_bytes()); // dwTargetSize (8-byte hdr + 4 data)
        body.extend_from_slice(&1u32.to_le_bytes()); // num elements

        // Element header + data
        body.extend_from_slice(&0x0800_0000u32.to_le_bytes()); // address
        body.extend_from_slice(&4u32.to_le_bytes()); // size
        body.extend_from_slice(&[0xCA, 0xFE, 0xBA, 0xBE]);

        // Wrap with DFU suffix
        body.extend_from_slice(&[0; 8]);
        body.extend_from_slice(b"UFD");
        body.extend_from_slice(&[0; 5]);

        let extracted = parse_dfu_file(&body).unwrap();
        assert_eq!(extracted, vec![0xCA, 0xFE, 0xBA, 0xBE]);
    }

    #[test]
    fn parse_intel_hex_first_span_returns_contiguous_bytes() {
        let hex = b":020000040800F2\n\
                    :04000000DEADBEEFC4\n\
                    :04000400CAFEBABEB8\n\
                    :00000001FF\n";
        let bytes = parse_intel_hex_first_span(hex).unwrap();
        assert_eq!(
            bytes,
            vec![0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]
        );
    }

    #[test]
    fn parse_intel_hex_first_span_stops_at_gap() {
        let hex = b":020000040800F2\n\
                    :04000000DEADBEEFC4\n\
                    :04010000CAFEBABEBB\n\
                    :00000001FF\n";
        let bytes = parse_intel_hex_first_span(hex).unwrap();
        assert_eq!(bytes, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }
}

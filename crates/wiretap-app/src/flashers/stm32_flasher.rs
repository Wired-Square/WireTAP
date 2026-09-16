//! STM32 UART firmware flasher.
//!
//! Implements ST AN3155 — the system bootloader protocol that lives in ROM
//! on every STM32 — directly over `serialport`. No third-party flasher
//! crate; the crates available (stm32-uart-loader, yapu, google's
//! stm32-bootloader-client) are all unmaintained and target old
//! `embedded-hal` traits rather than a desktop serial port.
//!
//! Operations exposed to the front-end:
//!
//! * `detect_chip` — pulse RTS/DTR to enter the system bootloader, do the
//!   `0x7F` autobaud, then GET + GET_ID. Probes RDP by attempting a 1-byte
//!   READ at the flash base.
//! * `flash` — accept `.bin` (writes at the user-supplied address) or Intel
//!   `.hex` (each record carries its own address). Mass-erase first, then
//!   write 256-byte chunks word-aligned with `0xFF` padding.
//! * `read_flash` — dump a region (or the full chip) back to a file.
//!   Surfaces a clear "Read protected (RDP)" error if the chip rejects the
//!   READ command.
//! * `erase` — full-chip mass erase via EXTENDED_ERASE if supported, else
//!   the legacy ERASE 0xFF.
//!
//! All serial work runs in `spawn_blocking`. Cancellation is co-operative:
//! long loops poll `super::is_cancelled` between chunks. Mid-frame cancel
//! desyncs the bootloader — that's fine, the user resets and reconnects.

use std::io::Write as _;
use std::thread::sleep;
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tauri::AppHandle;

use super::{
    emit_progress,
    is_cancelled,
    FlashPhase,
    FlasherProgress,
    Stm32ChipInfo,
    Stm32FlashOptions,
};

// ---------------------------------------------------------------------------
// AN3155 protocol constants
// ---------------------------------------------------------------------------

const SYNC_BYTE: u8 = 0x7F;
const ACK: u8 = 0x79;
const NACK: u8 = 0x1F;

const CMD_GET: u8 = 0x00;
const CMD_GET_ID: u8 = 0x02;
const CMD_READ_MEMORY: u8 = 0x11;
const CMD_WRITE_MEMORY: u8 = 0x31;
const CMD_ERASE: u8 = 0x43;
const CMD_EXTENDED_ERASE: u8 = 0x44;

const DEFAULT_BAUD: u32 = 115_200;
const DEFAULT_FLASH_BASE: u32 = 0x0800_0000;
const CHUNK: usize = 256;

const ACK_TIMEOUT: Duration = Duration::from_millis(2_000);
const ERASE_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Public entry points (mirror the ESP flasher shape)
// ---------------------------------------------------------------------------

pub async fn detect_chip(
    port: String,
    options: Stm32FlashOptions,
) -> Result<Stm32ChipInfo, String> {
    blocking(move || {
        let (mut p, info, pid, _pins) = connect(&port, &options)?;
        let rdp_level = match cmd_read_memory(p.as_mut(), DEFAULT_FLASH_BASE, 1) {
            Ok(_) => Some("0".to_string()),
            Err(_) => Some("1 (locked)".to_string()),
        };
        let (chip_name, flash_size_kb) = lookup_pid(pid);
        Ok(Stm32ChipInfo {
            chip: chip_name.to_string(),
            pid,
            bootloader_version: format!(
                "{}.{}",
                info.bootloader_version >> 4,
                info.bootloader_version & 0x0F,
            ),
            flash_size_kb,
            rdp_level,
        })
    })
    .await
}

pub async fn flash(
    app: AppHandle,
    flash_id: String,
    port: String,
    image_path: String,
    address: u32,
    options: Stm32FlashOptions,
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

        let (mut port_handle, info, pid, _pins) = connect(&port, &options)?;
        let p = port_handle.as_mut();

        let (chip_name, flash_size_kb) = lookup_pid(pid);
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Connecting,
            0,
            0,
            Some(format!(
                "Connected: {chip_name} (PID 0x{pid:04X}, BL v{}.{}{})",
                info.bootloader_version >> 4,
                info.bootloader_version & 0x0F,
                flash_size_kb
                    .map(|kb| format!(", {kb} KB flash"))
                    .unwrap_or_default(),
            )),
        );

        // Parse the image into one or more (address, data) spans.
        let spans = parse_image(&image_path, address)?;
        let total: u64 = spans.iter().map(|s| s.data.len() as u64).sum();
        if total == 0 {
            return Err("Firmware image is empty".to_string());
        }

        check_cancel(&flash_id_for_progress)?;

        // Mass-erase first. Prefer EXTENDED_ERASE (newer parts); fall back to
        // legacy ERASE on F1 / F0 / etc.
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Erasing,
            0,
            total,
            Some("Mass-erasing flash…".to_string()),
        );
        if info.supported_cmds.contains(&CMD_EXTENDED_ERASE) {
            cmd_extended_erase_mass(p)?;
        } else if info.supported_cmds.contains(&CMD_ERASE) {
            cmd_erase_legacy_mass(p)?;
        } else {
            return Err("Bootloader supports neither ERASE nor EXTENDED_ERASE".to_string());
        }

        check_cancel(&flash_id_for_progress)?;

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Writing,
            0,
            total,
            Some(format!("Writing {total} bytes")),
        );

        let mut done: u64 = 0;
        for span in &spans {
            let mut addr = span.address;
            for chunk in span.data.chunks(CHUNK) {
                check_cancel(&flash_id_for_progress)?;
                let padded = pad_word_with_ff(chunk);
                cmd_write_memory(p, addr, &padded)?;
                addr = addr.wrapping_add(padded.len() as u32);
                done += chunk.len() as u64;
                emit(
                    &app_for_progress,
                    &flash_id_for_progress,
                    FlashPhase::Writing,
                    done,
                    total,
                    None,
                );
            }
        }

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Verifying,
            total,
            total,
            Some("Flash complete; reset to run".to_string()),
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
    options: Stm32FlashOptions,
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

        let (mut port_handle, _info, pid, _pins) = connect(&port, &options)?;
        let p = port_handle.as_mut();

        // Resolve total size: explicit, else fall back to the PID lookup.
        let resolved_size = match size {
            Some(s) if s > 0 => s,
            _ => {
                let (_, kb) = lookup_pid(pid);
                kb.map(|k| k * 1024)
                    .ok_or_else(|| {
                        "Flash size unknown for this chip; specify a size manually"
                            .to_string()
                    })?
            }
        };

        let total = resolved_size as u64;
        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Writing,
            0,
            total,
            Some(format!(
                "Reading {total} bytes from 0x{offset:08X} to {output_path}"
            )),
        );

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
            let chunk_len = remaining.min(CHUNK as u32) as u8;
            let chunk = cmd_read_memory(p, current_offset, chunk_len)?;
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write {output_path}: {e}"))?;
            let n = chunk.len() as u32;
            bytes_done += n as u64;
            current_offset = current_offset.saturating_add(n);
            remaining = remaining.saturating_sub(n);
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
            Some(format!("Saved {total} bytes to {output_path}")),
        );

        Ok(())
    })
    .await
}

pub async fn erase(
    app: AppHandle,
    flash_id: String,
    port: String,
    options: Stm32FlashOptions,
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

        let (mut port_handle, info, _pid, _pins) = connect(&port, &options)?;
        let p = port_handle.as_mut();

        emit(
            &app_for_progress,
            &flash_id_for_progress,
            FlashPhase::Erasing,
            0,
            0,
            Some("Mass-erasing flash — this can take a minute…".to_string()),
        );

        if info.supported_cmds.contains(&CMD_EXTENDED_ERASE) {
            cmd_extended_erase_mass(p)?;
        } else if info.supported_cmds.contains(&CMD_ERASE) {
            cmd_erase_legacy_mass(p)?;
        } else {
            return Err("Bootloader supports neither ERASE nor EXTENDED_ERASE".to_string());
        }

        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Connection: open port + drive BOOT0/RESET + autobaud + GET + GET_ID
// ---------------------------------------------------------------------------

struct GetResult {
    bootloader_version: u8,
    supported_cmds: Vec<u8>,
}

fn connect(
    port: &str,
    opts: &Stm32FlashOptions,
) -> Result<(Box<dyn SerialPort>, GetResult, u16, PinMap), String> {
    let pins = PinMap::from(opts);
    let baud = opts.baud.unwrap_or(DEFAULT_BAUD);
    let mut p = open_port(port, baud)?;
    pins.enter_bootloader(p.as_mut())?;
    autobaud(p.as_mut())?;
    let info = cmd_get(p.as_mut())?;
    let pid = cmd_get_id(p.as_mut())?;
    Ok((p, info, pid, pins))
}

fn open_port(port: &str, baud: u32) -> Result<Box<dyn SerialPort>, String> {
    serialport::new(port, baud)
        .data_bits(DataBits::Eight)
        .parity(Parity::Even)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .timeout(ACK_TIMEOUT)
        .open()
        .map_err(|e| format!("Failed to open {port}: {e}"))
}

// ---------------------------------------------------------------------------
// BOOT0 / RESET pulse via RTS / DTR
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pin {
    Rts,
    Dtr,
}

fn parse_pin(s: Option<&str>, default: Option<Pin>) -> Option<Pin> {
    match s.map(|x| x.to_ascii_lowercase()).as_deref() {
        Some("rts") => Some(Pin::Rts),
        Some("dtr") => Some(Pin::Dtr),
        Some("none") | Some("") => None,
        Some(_) => default,
        None => default,
    }
}

struct PinMap {
    boot0: Option<Pin>,
    reset: Option<Pin>,
    boot0_invert: bool,
    reset_invert: bool,
}

impl PinMap {
    fn from(opts: &Stm32FlashOptions) -> Self {
        Self {
            boot0: parse_pin(opts.boot0_pin.as_deref(), Some(Pin::Dtr)),
            reset: parse_pin(opts.reset_pin.as_deref(), Some(Pin::Rts)),
            boot0_invert: opts.boot0_invert.unwrap_or(false),
            reset_invert: opts.reset_invert.unwrap_or(true),
        }
    }

    /// Drive `pin` to its asserted state. With `invert == false`, asserted =
    /// `level true`; with `invert == true`, asserted = `level false`. The
    /// invert flag exists so users can match whatever transistor wiring sits
    /// between the USB-serial chip and the STM32.
    fn drive(p: &mut dyn SerialPort, pin: Pin, asserted: bool, invert: bool) -> Result<(), String> {
        let level = asserted ^ invert;
        match pin {
            Pin::Rts => p
                .write_request_to_send(level)
                .map_err(|e| format!("Failed to set RTS: {e}")),
            Pin::Dtr => p
                .write_data_terminal_ready(level)
                .map_err(|e| format!("Failed to set DTR: {e}")),
        }
    }

    fn set_boot0(&self, p: &mut dyn SerialPort, asserted: bool) -> Result<(), String> {
        match self.boot0 {
            Some(pin) => Self::drive(p, pin, asserted, self.boot0_invert),
            None => Ok(()),
        }
    }

    fn set_reset(&self, p: &mut dyn SerialPort, asserted: bool) -> Result<(), String> {
        match self.reset {
            Some(pin) => Self::drive(p, pin, asserted, self.reset_invert),
            None => Ok(()),
        }
    }

    /// stm32flash-style entry sequence:
    ///   1. Hold reset, raise BOOT0
    ///   2. Release reset (chip samples BOOT0 → jumps to system bootloader)
    ///   3. Release BOOT0 (no longer sampled until next reset)
    /// Skipped on lines configured as `none`. Drains stale bytes from the RX
    /// buffer left over from the previous boot.
    fn enter_bootloader(&self, p: &mut dyn SerialPort) -> Result<(), String> {
        if self.boot0.is_none() && self.reset.is_none() {
            return Ok(());
        }
        self.set_reset(p, true)?;
        self.set_boot0(p, true)?;
        sleep(Duration::from_millis(50));
        self.set_reset(p, false)?;
        sleep(Duration::from_millis(150));
        self.set_boot0(p, false)?;
        let _ = p.clear(serialport::ClearBuffer::Input);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Protocol primitives
// ---------------------------------------------------------------------------

fn write_all(p: &mut dyn SerialPort, buf: &[u8]) -> Result<(), String> {
    p.write_all(buf).map_err(|e| format!("Serial write: {e}"))?;
    p.flush().map_err(|e| format!("Serial flush: {e}"))
}

fn read_exact(p: &mut dyn SerialPort, buf: &mut [u8]) -> Result<(), String> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = p
            .read(&mut buf[filled..])
            .map_err(|e| format!("Serial read: {e}"))?;
        if n == 0 {
            return Err("Serial read returned 0 bytes (timeout)".to_string());
        }
        filled += n;
    }
    Ok(())
}

fn read_byte(p: &mut dyn SerialPort) -> Result<u8, String> {
    let mut buf = [0u8; 1];
    read_exact(p, &mut buf)?;
    Ok(buf[0])
}

fn wait_ack(p: &mut dyn SerialPort) -> Result<(), String> {
    match read_byte(p)? {
        ACK => Ok(()),
        NACK => Err("Device returned NACK".to_string()),
        other => Err(format!("Unexpected byte 0x{other:02X} (expected ACK/NACK)")),
    }
}

/// Initial sync: send `0x7F`, expect ACK. The bootloader auto-bauds and locks
/// 8E1 for the rest of the session.
fn autobaud(p: &mut dyn SerialPort) -> Result<(), String> {
    write_all(p, &[SYNC_BYTE])?;
    wait_ack(p).map_err(|e| {
        format!(
            "Bootloader handshake failed: {e}. \
             Check BOOT0/RESET wiring or hold BOOT0 manually before connecting."
        )
    })
}

/// Send a command byte + its complement, then wait for ACK.
fn send_command(p: &mut dyn SerialPort, cmd: u8) -> Result<(), String> {
    write_all(p, &[cmd, cmd ^ 0xFF])?;
    wait_ack(p)
}

/// Send a 32-bit address big-endian + XOR checksum, then wait for ACK.
fn send_address(p: &mut dyn SerialPort, addr: u32) -> Result<(), String> {
    let bytes = addr.to_be_bytes();
    let xor = bytes.iter().fold(0u8, |a, b| a ^ b);
    write_all(p, &[bytes[0], bytes[1], bytes[2], bytes[3], xor])?;
    wait_ack(p)
}

/// Send `[N=len-1][data...][XOR(N, data...)]`, then wait for ACK. `data`
/// must be 1..=256 bytes.
fn send_data(p: &mut dyn SerialPort, data: &[u8]) -> Result<(), String> {
    if data.is_empty() || data.len() > 256 {
        return Err(format!("send_data: invalid length {}", data.len()));
    }
    let n = (data.len() - 1) as u8;
    let mut xor = n;
    for &b in data {
        xor ^= b;
    }
    let mut framed = Vec::with_capacity(data.len() + 2);
    framed.push(n);
    framed.extend_from_slice(data);
    framed.push(xor);
    write_all(p, &framed)
}

// ---------------------------------------------------------------------------
// High-level commands
// ---------------------------------------------------------------------------

/// GET: returns bootloader version + supported command list.
///
/// AN3155 framing: ACK | N | bootloader_version | cmd1..cmdN | ACK
/// where N = number of supported commands (so N+1 bytes follow before the
/// trailing ACK).
fn cmd_get(p: &mut dyn SerialPort) -> Result<GetResult, String> {
    send_command(p, CMD_GET)?;
    let n = read_byte(p)?;
    let mut payload = vec![0u8; (n as usize) + 1];
    read_exact(p, &mut payload)?;
    wait_ack(p)?;
    let bootloader_version = payload[0];
    let supported_cmds = payload[1..].to_vec();
    Ok(GetResult {
        bootloader_version,
        supported_cmds,
    })
}

/// GET_ID: returns the 12-bit product ID.
///
/// AN3155 framing: ACK | N=1 | PID_MSB | PID_LSB | ACK
fn cmd_get_id(p: &mut dyn SerialPort) -> Result<u16, String> {
    send_command(p, CMD_GET_ID)?;
    let n = read_byte(p)?;
    let mut payload = vec![0u8; (n as usize) + 1];
    read_exact(p, &mut payload)?;
    wait_ack(p)?;
    if payload.len() < 2 {
        return Err(format!("GET_ID returned {} bytes, expected >= 2", payload.len()));
    }
    Ok(((payload[0] as u16) << 8) | payload[1] as u16)
}

/// READ_MEMORY: read up to 256 bytes from `addr`.
///
/// On RDP Level 1, the device NACKs after the address — we map that to a
/// clear error so the UI can explain why backup failed.
fn cmd_read_memory(
    p: &mut dyn SerialPort,
    addr: u32,
    len: u8,
) -> Result<Vec<u8>, String> {
    if len == 0 {
        return Err("cmd_read_memory: len must be >= 1".to_string());
    }
    send_command(p, CMD_READ_MEMORY).map_err(rdp_hint_on_nack)?;
    send_address(p, addr).map_err(rdp_hint_on_nack)?;
    let n = len - 1;
    write_all(p, &[n, n ^ 0xFF])?;
    wait_ack(p).map_err(rdp_hint_on_nack)?;
    let mut buf = vec![0u8; len as usize];
    read_exact(p, &mut buf)?;
    Ok(buf)
}

fn rdp_hint_on_nack(err: String) -> String {
    if err.contains("NACK") {
        "Read protected (RDP Level 1) — disable readout protection to back up flash".to_string()
    } else {
        err
    }
}

/// WRITE_MEMORY: write 1..=256 bytes to `addr`. `data` must be word-aligned
/// (use [`pad_word_with_ff`] before calling).
fn cmd_write_memory(p: &mut dyn SerialPort, addr: u32, data: &[u8]) -> Result<(), String> {
    if data.len() % 4 != 0 {
        return Err(format!(
            "cmd_write_memory: length {} not word-aligned",
            data.len()
        ));
    }
    send_command(p, CMD_WRITE_MEMORY)?;
    send_address(p, addr)?;
    send_data(p, data)?;
    wait_ack(p)
}

/// EXTENDED_ERASE mass-erase (PID supports it): send 0x44, then `[0xFF, 0xFF,
/// 0x00]` (mass-erase code + XOR). Wait up to 60s for the ACK.
fn cmd_extended_erase_mass(p: &mut dyn SerialPort) -> Result<(), String> {
    send_command(p, CMD_EXTENDED_ERASE)?;
    write_all(p, &[0xFF, 0xFF, 0x00])?;
    with_timeout(p, ERASE_TIMEOUT, |p| wait_ack(p))
}

/// Legacy ERASE mass-erase: send 0x43, then `[0xFF, 0x00]` (mass-erase code +
/// XOR). Wait up to 60s for the ACK.
fn cmd_erase_legacy_mass(p: &mut dyn SerialPort) -> Result<(), String> {
    send_command(p, CMD_ERASE)?;
    write_all(p, &[0xFF, 0x00])?;
    with_timeout(p, ERASE_TIMEOUT, |p| wait_ack(p))
}

fn with_timeout<F, T>(
    p: &mut dyn SerialPort,
    new_timeout: Duration,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&mut dyn SerialPort) -> Result<T, String>,
{
    let saved = p.timeout();
    p.set_timeout(new_timeout)
        .map_err(|e| format!("set_timeout: {e}"))?;
    let result = f(p);
    let _ = p.set_timeout(saved);
    result
}

// ---------------------------------------------------------------------------
// Image parsing (.bin and Intel .hex)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct WriteSpan {
    address: u32,
    data: Vec<u8>,
}

fn parse_image(path: &str, base_address: u32) -> Result<Vec<WriteSpan>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    if path.to_ascii_lowercase().ends_with(".hex") {
        parse_intel_hex(&bytes)
    } else {
        Ok(vec![WriteSpan {
            address: base_address,
            data: bytes,
        }])
    }
}

fn parse_intel_hex(bytes: &[u8]) -> Result<Vec<WriteSpan>, String> {
    use ihex::Record;
    let text = std::str::from_utf8(bytes)
        .map_err(|e| format!("Intel HEX file is not valid UTF-8: {e}"))?;

    let mut upper: u32 = 0;
    let mut spans: Vec<WriteSpan> = Vec::new();

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
                if let Some(last) = spans.last_mut() {
                    if last.address.wrapping_add(last.data.len() as u32) == addr {
                        last.data.extend_from_slice(&value);
                        continue;
                    }
                }
                spans.push(WriteSpan {
                    address: addr,
                    data: value,
                });
            }
            Record::ExtendedLinearAddress(u) => upper = (u as u32) << 16,
            Record::ExtendedSegmentAddress(s) => upper = (s as u32) << 4,
            Record::EndOfFile
            | Record::StartLinearAddress(_)
            | Record::StartSegmentAddress { .. } => {}
        }
    }

    if spans.is_empty() {
        return Err("Intel HEX file has no data records".to_string());
    }
    Ok(spans)
}

/// Pad `data` up to the next multiple of 4 bytes with `0xFF` (the
/// erased-flash value). The bootloader requires word-aligned writes on most
/// STM32 families.
fn pad_word_with_ff(data: &[u8]) -> Vec<u8> {
    let mut v = data.to_vec();
    while v.len() % 4 != 0 {
        v.push(0xFF);
    }
    v
}

// ---------------------------------------------------------------------------
// PID lookup — common STM32 product IDs
// ---------------------------------------------------------------------------

/// Map an STM32 PID (returned by GET_ID) to a friendly chip name and best-
/// effort flash size in KB. Sizes are conservative defaults — the real size
/// for a specific part lives in the chip's electronic-signature region and
/// can be probed later if needed.
fn lookup_pid(pid: u16) -> (&'static str, Option<u32>) {
    match pid {
        // F0
        0x440 => ("STM32F05x / F030x8", Some(64)),
        0x442 => ("STM32F09x", Some(256)),
        0x444 => ("STM32F03x", Some(32)),
        0x445 => ("STM32F04x", Some(16)),
        0x448 => ("STM32F07x", Some(128)),
        // F1
        0x410 => ("STM32F1 medium-density", Some(128)),
        0x412 => ("STM32F1 low-density", Some(32)),
        0x414 => ("STM32F1 high-density", Some(512)),
        0x418 => ("STM32F105/F107 connectivity", Some(256)),
        0x420 => ("STM32F1 medium-density VL", Some(128)),
        0x428 => ("STM32F1 high-density VL", Some(512)),
        0x430 => ("STM32F1 XL-density", Some(1024)),
        // F2
        0x411 => ("STM32F2", Some(1024)),
        // F3
        0x422 => ("STM32F30x / F31x", Some(256)),
        0x432 => ("STM32F37x", Some(256)),
        0x438 => ("STM32F33x", Some(64)),
        0x439 => ("STM32F35x", Some(64)),
        0x446 => ("STM32F302xD/E / F303xD/E", Some(512)),
        // F4
        0x413 => ("STM32F40x / F41x", Some(1024)),
        0x419 => ("STM32F42x / F43x", Some(2048)),
        0x423 => ("STM32F401x B/C", Some(256)),
        0x431 => ("STM32F411xC/E", Some(512)),
        0x433 => ("STM32F401x D/E", Some(512)),
        0x434 => ("STM32F469 / F479", Some(2048)),
        0x441 => ("STM32F412", Some(1024)),
        0x458 => ("STM32F410", Some(128)),
        0x463 => ("STM32F413 / F423", Some(1536)),
        // F7
        0x449 => ("STM32F74x / F75x", Some(1024)),
        0x451 => ("STM32F76x / F77x", Some(2048)),
        0x452 => ("STM32F72x / F73x", Some(512)),
        // L0
        0x417 => ("STM32L05x / L06x", Some(64)),
        0x425 => ("STM32L03x / L04x", Some(32)),
        0x447 => ("STM32L07x / L08x", Some(192)),
        0x457 => ("STM32L01x / L02x", Some(16)),
        // L1
        0x416 => ("STM32L1 cat.1", Some(128)),
        0x429 => ("STM32L1 cat.2", Some(128)),
        0x427 => ("STM32L1 cat.3", Some(256)),
        0x436 => ("STM32L1 cat.4 / cat.3 medium+", Some(384)),
        0x437 => ("STM32L1 cat.5 / cat.6", Some(512)),
        // L4
        0x415 => ("STM32L47x / L48x", Some(1024)),
        0x435 => ("STM32L43x / L44x", Some(256)),
        0x461 => ("STM32L496 / L4A6", Some(1024)),
        0x462 => ("STM32L45x / L46x", Some(512)),
        0x464 => ("STM32L41x / L42x", Some(128)),
        0x470 => ("STM32L4Rx / L4Sx", Some(2048)),
        0x471 => ("STM32L4P5 / L4Q5", Some(1024)),
        // G0 / G4
        0x460 => ("STM32G07x / G08x", Some(128)),
        0x466 => ("STM32G03x / G04x", Some(64)),
        0x468 => ("STM32G43x / G44x", Some(128)),
        0x469 => ("STM32G47x / G48x", Some(512)),
        // H7
        0x450 => ("STM32H74x / H75x", Some(2048)),
        0x480 => ("STM32H7A3 / H7B3 / H7B0", Some(2048)),
        0x483 => ("STM32H72x / H73x", Some(1024)),
        // WB / WL
        0x495 => ("STM32WB55", Some(1024)),
        0x497 => ("STM32WLEx", Some(256)),
        _ => ("STM32 (unknown)", None),
    }
}

// ---------------------------------------------------------------------------
// Progress / cancellation glue (mirrors esp_flasher.rs)
// ---------------------------------------------------------------------------

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
        .map_err(|e| format!("STM32 flasher task panicked: {e}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_word_with_ff_pads_to_4() {
        assert_eq!(pad_word_with_ff(&[1]), vec![1, 0xFF, 0xFF, 0xFF]);
        assert_eq!(pad_word_with_ff(&[1, 2, 3, 4]), vec![1, 2, 3, 4]);
        assert_eq!(
            pad_word_with_ff(&[1, 2, 3, 4, 5]),
            vec![1, 2, 3, 4, 5, 0xFF, 0xFF, 0xFF],
        );
        assert!(pad_word_with_ff(&[]).is_empty());
    }

    #[test]
    fn parse_intel_hex_coalesces_contiguous_data() {
        // Two contiguous data records at 0x0800_0000 — should coalesce.
        let hex = b":020000040800F2\n\
                    :04000000DEADBEEFC4\n\
                    :04000400CAFEBABEB8\n\
                    :00000001FF\n";
        let spans = parse_intel_hex(hex).unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].address, 0x0800_0000);
        assert_eq!(
            spans[0].data,
            vec![0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]
        );
    }

    #[test]
    fn parse_intel_hex_splits_non_contiguous() {
        // Two records with a gap — should produce two spans.
        let hex = b":020000040800F2\n\
                    :04000000DEADBEEFC4\n\
                    :04010000CAFEBABEBB\n\
                    :00000001FF\n";
        let spans = parse_intel_hex(hex).unwrap();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].address, 0x0800_0000);
        assert_eq!(spans[1].address, 0x0800_0100);
    }

    #[test]
    fn lookup_pid_known_and_unknown() {
        assert_eq!(lookup_pid(0x410).0, "STM32F1 medium-density");
        assert_eq!(lookup_pid(0x451).0, "STM32F76x / F77x");
        assert_eq!(lookup_pid(0xFFFF), ("STM32 (unknown)", None));
    }

    #[test]
    fn parse_pin_round_trip() {
        assert_eq!(parse_pin(Some("rts"), None), Some(Pin::Rts));
        assert_eq!(parse_pin(Some("DTR"), None), Some(Pin::Dtr));
        assert_eq!(parse_pin(Some("none"), Some(Pin::Rts)), None);
        assert_eq!(parse_pin(None, Some(Pin::Dtr)), Some(Pin::Dtr));
        // Unknown string falls back to default.
        assert_eq!(parse_pin(Some("xyz"), Some(Pin::Rts)), Some(Pin::Rts));
    }
}

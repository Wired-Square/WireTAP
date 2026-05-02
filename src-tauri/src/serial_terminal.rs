//! Direct serial-terminal backend for the Serial app.
//!
//! Bypasses the multi-source IO session pipeline — the terminal owns a
//! dedicated `serialport` handle and a single read loop that emits bytes
//! straight to the frontend. Each open terminal has a UUID-style id and
//! its own cancel flag.

#![cfg(not(target_os = "ios"))]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::io::serial::utils::{
    to_serialport_data_bits, to_serialport_parity, to_serialport_stop_bits, Parity,
};

const SERIAL_TERMINAL_DATA_EVENT: &str = "serial-terminal-data";

#[derive(Clone, Serialize)]
struct TerminalDataPayload {
    terminal_id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct TerminalErrorPayload {
    terminal_id: String,
    message: String,
}

const SERIAL_TERMINAL_ERROR_EVENT: &str = "serial-terminal-error";

struct Terminal {
    /// Writer-only handle — separate from the reader so writes don't block on
    /// the reader's `read()` call. Backed by the same OS file descriptor via
    /// `SerialPort::try_clone`, so DTR/RTS toggles affect the live port.
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    stop_flag: Arc<AtomicBool>,
}

static TERMINALS: Lazy<Mutex<HashMap<String, Terminal>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn new_terminal_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("term_{:x}", nanos as u64)
}

fn parse_parity(s: &str) -> Parity {
    match s.to_ascii_lowercase().as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn serial_terminal_open(
    app: AppHandle,
    port: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
) -> Result<String, String> {
    let data_bits = data_bits.unwrap_or(8);
    let stop_bits = stop_bits.unwrap_or(1);
    let parity = parse_parity(parity.as_deref().unwrap_or("none"));

    // Short read timeout keeps the reader loop responsive to the stop flag
    // without paying serialise/event overhead. Writes go through a cloned
    // handle, so the read timeout no longer affects write latency.
    let mut reader = serialport::new(&port, baud_rate)
        .data_bits(to_serialport_data_bits(data_bits))
        .stop_bits(to_serialport_stop_bits(stop_bits))
        .parity(to_serialport_parity(&parity))
        .timeout(Duration::from_millis(10))
        .open()
        .map_err(|e| format!("Failed to open {}: {}", port, e))?;

    let writer = reader
        .try_clone()
        .map_err(|e| format!("Failed to clone serial handle for writes: {}", e))?;

    let terminal_id = new_terminal_id();
    let writer_handle = Arc::new(Mutex::new(writer));
    let stop_flag = Arc::new(AtomicBool::new(false));

    {
        let mut map = TERMINALS.lock().unwrap();
        map.insert(
            terminal_id.clone(),
            Terminal {
                writer: writer_handle.clone(),
                stop_flag: stop_flag.clone(),
            },
        );
    }

    tlog!(
        "[serial_terminal] Opened {} (terminal_id={}, baud={}, {}{}{})",
        port,
        terminal_id,
        baud_rate,
        data_bits,
        match parity {
            Parity::None => "N",
            Parity::Odd => "O",
            Parity::Even => "E",
        },
        stop_bits
    );

    let id_for_task = terminal_id.clone();
    let app_for_task = app.clone();
    let stop_flag_for_task = stop_flag.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        // The reader thread owns its handle outright — writes go through the
        // cloned `writer` handle behind the mutex, so this loop never
        // contends with the writer.
        while !stop_flag_for_task.load(Ordering::SeqCst) {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let _ = app_for_task.emit(
                        SERIAL_TERMINAL_DATA_EVENT,
                        TerminalDataPayload {
                            terminal_id: id_for_task.clone(),
                            bytes: buf[..n].to_vec(),
                        },
                    );
                }
                Ok(_) => { /* zero bytes — short timeout, loop */ }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Expected: short read timeout. Loop again.
                }
                Err(e) => {
                    let _ = app_for_task.emit(
                        SERIAL_TERMINAL_ERROR_EVENT,
                        TerminalErrorPayload {
                            terminal_id: id_for_task.clone(),
                            message: format!("Read error: {}", e),
                        },
                    );
                    return;
                }
            }
        }
        tlog!("[serial_terminal] Read loop exited for {}", id_for_task);
    });

    Ok(terminal_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn serial_terminal_close(terminal_id: String) -> Result<(), String> {
    let removed = {
        let mut map = TERMINALS.lock().unwrap();
        map.remove(&terminal_id)
    };
    match removed {
        Some(t) => {
            t.stop_flag.store(true, Ordering::SeqCst);
            tlog!("[serial_terminal] Closed terminal {}", terminal_id);
            Ok(())
        }
        None => Err(format!("Terminal {} not found", terminal_id)),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn serial_terminal_write(terminal_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let port = {
        let map = TERMINALS.lock().unwrap();
        map.get(&terminal_id)
            .map(|t| t.writer.clone())
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?
    };
    let mut p = port
        .lock()
        .map_err(|e| format!("Port mutex poisoned: {}", e))?;
    p.write_all(&bytes)
        .and_then(|_| p.flush())
        .map_err(|e| format!("Write error: {}", e))
}

/// Pulse RTS low → high to reset the connected µC.
///
/// This works for the common dev-board wiring where RTS is tied (often
/// through a transistor) to the chip's reset line — ESP32 dev kits,
/// Arduino-style boards, Black Pill flashed with DAPLink, etc. Boards that
/// instead route reset through DTR are covered by the parallel DTR pulse.
#[tauri::command(rename_all = "snake_case")]
pub fn serial_terminal_reset(terminal_id: String) -> Result<(), String> {
    let port = {
        let map = TERMINALS.lock().unwrap();
        map.get(&terminal_id)
            .map(|t| t.writer.clone())
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?
    };
    let mut p = port
        .lock()
        .map_err(|e| format!("Port mutex poisoned: {}", e))?;

    // Assert reset (RTS+DTR low) — covers boards that route reset through
    // either control line. DTR low alone is the Arduino reset; RTS low
    // alone is the ESP32 EN line.
    p.write_request_to_send(true)
        .map_err(|e| format!("Failed to assert RTS: {}", e))?;
    p.write_data_terminal_ready(true)
        .map_err(|e| format!("Failed to assert DTR: {}", e))?;
    std::thread::sleep(Duration::from_millis(100));
    p.write_request_to_send(false)
        .map_err(|e| format!("Failed to release RTS: {}", e))?;
    p.write_data_terminal_ready(false)
        .map_err(|e| format!("Failed to release DTR: {}", e))?;

    tlog!("[serial_terminal] Reset pulse on {}", terminal_id);
    Ok(())
}

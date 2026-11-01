//! Direct serial-terminal backend for the Serial app.
//!
//! Bypasses the multi-source IO session pipeline — the terminal owns a
//! dedicated `wslib_serial` task whose reads are emitted straight to the
//! frontend. Each open terminal has a UUID-style id and its own stop token.

#![cfg(not(target_os = "ios"))]

use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use wslib_serial::{
    Access, LineSettings, SerialEvent, SerialOptions, SerialTask, SerialWriter, WriteRefused,
};

use crate::blocking::off_runtime;

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
    writer: SerialWriter,
    stop: CancellationToken,
}

static TERMINALS: Lazy<Mutex<HashMap<String, Terminal>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn new_terminal_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("term_{:x}", nanos as u64)
}

/// A read error ends the terminal with `serial-terminal-error` rather than
/// reopening the port.
fn terminal_options() -> SerialOptions {
    SerialOptions {
        access: Access::ReadWrite,
        reopen: None,
        ..SerialOptions::default()
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn serial_terminal_open(
    app: AppHandle,
    port: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
) -> Result<String, String> {
    let line = LineSettings::parse(baud_rate, data_bits, stop_bits, parity.as_deref())?;
    let path = port.clone();
    let task = off_runtime(move || wslib_serial::open(path, line, terminal_options()))
        .await
        .map_err(|e| e.to_string())?;

    let terminal_id = new_terminal_id();
    let stop = CancellationToken::new();
    TERMINALS.lock().unwrap().insert(
        terminal_id.clone(),
        Terminal {
            writer: task.writer(),
            stop: stop.clone(),
        },
    );
    tlog!(
        "[serial_terminal] Opened {} (terminal_id={}, {})",
        port,
        terminal_id,
        line
    );

    tauri::async_runtime::spawn(forward_reads(app, terminal_id.clone(), task, stop));
    Ok(terminal_id)
}

async fn forward_reads(
    app: AppHandle,
    terminal_id: String,
    mut task: SerialTask,
    stop: CancellationToken,
) {
    loop {
        let event = tokio::select! {
            () = stop.cancelled() => break,
            event = task.next_event() => event,
        };
        match event {
            Some(SerialEvent::Read { bytes, .. }) => {
                let _ = app.emit(
                    SERIAL_TERMINAL_DATA_EVENT,
                    TerminalDataPayload {
                        terminal_id: terminal_id.clone(),
                        bytes,
                    },
                );
            }
            Some(SerialEvent::Disconnected { error, .. }) => {
                let _ = app.emit(
                    SERIAL_TERMINAL_ERROR_EVENT,
                    TerminalErrorPayload {
                        terminal_id: terminal_id.clone(),
                        message: format!("Read error: {}", error),
                    },
                );
            }
            Some(SerialEvent::Connected) => {}
            None => break,
        }
    }
    task.stop().await;
    tlog!("[serial_terminal] Read loop exited for {}", terminal_id);
}

#[tauri::command(rename_all = "snake_case")]
pub async fn serial_terminal_close(terminal_id: String) -> Result<(), String> {
    let removed = TERMINALS.lock().unwrap().remove(&terminal_id);
    match removed {
        Some(t) => {
            t.stop.cancel();
            tlog!("[serial_terminal] Closed terminal {}", terminal_id);
            Ok(())
        }
        None => Err(format!("Terminal {} not found", terminal_id)),
    }
}

fn writer(terminal_id: &str) -> Result<SerialWriter, String> {
    TERMINALS
        .lock()
        .unwrap()
        .get(terminal_id)
        .map(|t| t.writer.clone())
        .ok_or_else(|| format!("Terminal {} not found", terminal_id))
}

fn answered(what: &str, answer: Result<io::Result<()>, WriteRefused>) -> Result<(), String> {
    match answer {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("{}: {}", what, e)),
        Err(e) => Err(format!("{}: {}", what, e)),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn serial_terminal_write(terminal_id: String, bytes: Vec<u8>) -> Result<(), String> {
    answered("Write error", writer(&terminal_id)?.write(bytes).await)
}

/// Pulse RTS and DTR low → high to reset the connected µC.
///
/// This works for the common dev-board wiring where RTS is tied (often
/// through a transistor) to the chip's reset line — ESP32 dev kits,
/// Arduino-style boards, Black Pill flashed with DAPLink, etc. Boards that
/// instead route reset through DTR are covered by the parallel DTR pulse.
#[tauri::command(rename_all = "snake_case")]
pub async fn serial_terminal_reset(terminal_id: String) -> Result<(), String> {
    let writer = writer(&terminal_id)?;
    set_reset_lines(&writer, true, "assert").await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    set_reset_lines(&writer, false, "release").await?;
    tlog!("[serial_terminal] Reset pulse on {}", terminal_id);
    Ok(())
}

/// Queues RTS then DTR together, so the task sets them back to back rather
/// than with a read between them.
async fn set_reset_lines(writer: &SerialWriter, level: bool, verb: &str) -> Result<(), String> {
    let (rts, dtr) = futures::join!(writer.set_rts(level), writer.set_dtr(level));
    answered(&format!("Failed to {} RTS", verb), rts)?;
    answered(&format!("Failed to {} DTR", verb), dtr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_writes_and_ends_on_its_first_loss() {
        let options = terminal_options();
        assert_eq!(options.access, Access::ReadWrite);
        assert_eq!(options.reopen, None);
    }
}

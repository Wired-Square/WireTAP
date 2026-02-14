// ui/src-tauri/src/transmit.rs
//
// Tauri commands for CAN frame and serial byte transmission.
//
// Transmission works through existing IO sessions (created by Discovery/Decoder or Transmit app).
// This approach avoids creating duplicate connections and integrates with the session model.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

use crate::io::{self, CanTransmitFrame, IOCapabilities};
use crate::settings::{load_settings, IOProfile};

// ============================================================================
// Types
// ============================================================================

/// Writer capabilities - what a transmit-capable profile supports
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WriterCapabilities {
    pub can_transmit_can: bool,
    pub can_transmit_serial: bool,
    pub supports_canfd: bool,
    pub supports_extended_id: bool,
    pub supports_rtr: bool,
    pub available_buses: Vec<u8>,
}

/// Profile info with transmit capabilities
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransmitProfile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub capabilities: WriterCapabilities,
}

/// Transmit result returned by transmission functions
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransmitResult {
    pub success: bool,
    pub timestamp_us: u64,
    pub error: Option<String>,
}

/// Event payload for CAN transmit history (emitted during repeat transmits)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransmitHistoryEvent {
    pub session_id: String,
    pub queue_id: String,
    pub frame: CanTransmitFrame,
    pub success: bool,
    pub timestamp_us: u64,
    pub error: Option<String>,
}

/// Event payload for serial transmit history (emitted during repeat transmits)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialTransmitHistoryEvent {
    pub session_id: String,
    pub queue_id: String,
    pub bytes: Vec<u8>,
    pub success: bool,
    pub timestamp_us: u64,
    pub error: Option<String>,
}

/// Event payload for repeat stopped (emitted when repeat stops due to permanent error)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepeatStoppedEvent {
    pub queue_id: String,
    pub reason: String,
}

/// Kinds that support CAN transmit (platform-dependent)
#[cfg(not(target_os = "ios"))]
const CAN_TRANSMIT_KINDS: [&str; 5] = ["slcan", "gvret_tcp", "gvret_usb", "socketcan", "gs_usb"];
#[cfg(target_os = "ios")]
const CAN_TRANSMIT_KINDS: [&str; 1] = ["gvret_tcp"];

/// Kinds that support serial transmit (not available on iOS)
#[cfg(not(target_os = "ios"))]
const SERIAL_TRANSMIT_KINDS: [&str; 1] = ["serial"];
#[cfg(target_os = "ios")]
const SERIAL_TRANSMIT_KINDS: [&str; 0] = [];

// ============================================================================
// Helper Functions
// ============================================================================

/// Check if a profile kind supports CAN transmit
fn supports_can_transmit(kind: &str) -> bool {
    CAN_TRANSMIT_KINDS.contains(&kind)
}

/// Check if a profile kind supports serial transmit
fn supports_serial_transmit(kind: &str) -> bool {
    SERIAL_TRANSMIT_KINDS.contains(&kind)
}

/// Get capabilities for a profile kind
fn get_capabilities_for_kind(kind: &str, profile: &IOProfile) -> WriterCapabilities {
    match kind {
        "slcan" => {
            // Check if silent mode is enabled - if so, no transmit
            // Default is true (silent mode) for safety - must explicitly set false to transmit
            let silent_mode = profile
                .connection
                .get("silent_mode")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            if silent_mode {
                WriterCapabilities {
                    can_transmit_can: false, // Can't transmit in silent mode
                    can_transmit_serial: false,
                    supports_canfd: false,
                    supports_extended_id: true,
                    supports_rtr: true,
                    available_buses: vec![],
                }
            } else {
                WriterCapabilities {
                    can_transmit_can: true,
                    can_transmit_serial: false,
                    supports_canfd: false, // Classic slcan doesn't support CAN FD
                    supports_extended_id: true,
                    supports_rtr: true,
                    available_buses: vec![], // Single bus
                }
            }
        }
        "gvret_tcp" | "gvret_usb" => WriterCapabilities {
            can_transmit_can: true,
            can_transmit_serial: false,
            supports_canfd: true,
            supports_extended_id: true,
            supports_rtr: false,
            available_buses: vec![0, 1, 2, 3, 4], // Bus 0-4 (device-dependent)
        },
        "socketcan" => WriterCapabilities {
            can_transmit_can: cfg!(target_os = "linux"),
            can_transmit_serial: false,
            supports_canfd: true,
            supports_extended_id: true,
            supports_rtr: true,
            available_buses: vec![], // Single interface
        },
        "serial" => WriterCapabilities {
            can_transmit_can: false,
            can_transmit_serial: true,
            supports_canfd: false,
            supports_extended_id: false,
            supports_rtr: false,
            available_buses: vec![],
        },
        _ => WriterCapabilities {
            can_transmit_can: false,
            can_transmit_serial: false,
            supports_canfd: false,
            supports_extended_id: false,
            supports_rtr: false,
            available_buses: vec![],
        },
    }
}

// ============================================================================
// Tauri Commands - Profile Query
// ============================================================================

/// Get all IO profiles that support transmission
#[tauri::command]
pub async fn get_transmit_capable_profiles(app: AppHandle) -> Result<Vec<TransmitProfile>, String> {
    let settings = load_settings(app).await?;

    let mut profiles = Vec::new();

    for profile in &settings.io_profiles {
        let supports_can = supports_can_transmit(&profile.kind);
        let supports_serial = supports_serial_transmit(&profile.kind);

        if supports_can || supports_serial {
            let capabilities = get_capabilities_for_kind(&profile.kind, profile);

            // Only include if actually capable of transmitting
            if capabilities.can_transmit_can || capabilities.can_transmit_serial {
                profiles.push(TransmitProfile {
                    id: profile.id.clone(),
                    name: profile.name.clone(),
                    kind: profile.kind.clone(),
                    capabilities,
                });
            }
        }
    }

    Ok(profiles)
}

/// Get the current usage of a profile (if any)
#[tauri::command]
pub async fn get_profile_usage(
    profile_id: String,
) -> Result<Option<crate::profile_tracker::ProfileUsage>, String> {
    Ok(crate::profile_tracker::get_usage(&profile_id))
}

// ============================================================================
// IO Session-Based Transmit Commands
// ============================================================================
//
// These commands transmit through existing IO sessions, avoiding the need
// for separate writer connections. The IO session must be started first.

/// Transmit a CAN frame through an existing IO session
#[tauri::command]
pub async fn io_transmit_can_frame(
    session_id: String,
    frame: CanTransmitFrame,
) -> Result<crate::io::TransmitResult, String> {
    io::transmit_frame(&session_id, &frame).await
}

/// Transmit raw serial bytes through an IO session
#[tauri::command]
pub async fn io_transmit_serial(
    session_id: String,
    bytes: Vec<u8>,
) -> Result<crate::io::TransmitResult, String> {
    io::transmit_serial(&session_id, &bytes).await
}

/// Get IO session capabilities (includes transmit capabilities)
#[tauri::command]
pub async fn get_io_session_capabilities(session_id: String) -> Result<Option<IOCapabilities>, String> {
    Ok(io::get_session_capabilities(&session_id).await)
}

// ============================================================================
// IO Session Repeat Transmit
// ============================================================================

/// Counter for generating unique repeat task IDs
static IO_REPEAT_TASK_COUNTER: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// Simple Transmit Helpers
// ============================================================================

/// Check if an error is permanent (should stop repeat) vs transient (can continue)
fn is_permanent_error(error: &str) -> bool {
    let error_lower = error.to_lowercase();
    // Permanent errors - device is gone or session invalid
    error_lower.contains("not found")
        || error_lower.contains("disconnected")
        || error_lower.contains("does not support")
        || error_lower.contains("no device")
        || error_lower.contains("permission denied")
        || error_lower.contains("access denied")
}

/// Simple transmit - no retry logic.
/// Returns (result, should_stop) where should_stop is true if repeat should end.
async fn do_transmit(
    session_id: &str,
    frame: &CanTransmitFrame,
) -> (Result<crate::io::TransmitResult, String>, bool) {
    let result = io::transmit_frame(session_id, frame).await;

    match &result {
        Ok(r) if r.success => (result, false),
        Ok(r) => {
            let error = r.error.as_deref().unwrap_or("Unknown error");
            let should_stop = is_permanent_error(error);
            (result, should_stop)
        }
        Err(e) => {
            let should_stop = is_permanent_error(e);
            (result, should_stop)
        }
    }
}

/// Simple serial transmit - no retry logic.
async fn do_serial_transmit(
    session_id: &str,
    bytes: &[u8],
) -> (Result<crate::io::TransmitResult, String>, bool) {
    let result = io::transmit_serial(session_id, bytes).await;

    match &result {
        Ok(r) if r.success => (result, false),
        Ok(r) => {
            let error = r.error.as_deref().unwrap_or("Unknown error");
            let should_stop = is_permanent_error(error);
            (result, should_stop)
        }
        Err(e) => {
            let should_stop = is_permanent_error(e);
            (result, should_stop)
        }
    }
}

/// Active repeat transmit task for IO sessions
struct IoRepeatTask {
    /// Cancel flag for the repeat loop
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Task handle
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Map of queue_id -> IoRepeatTask for active repeat transmissions via IO sessions
static IO_REPEAT_TASKS: Lazy<tokio::sync::Mutex<HashMap<String, IoRepeatTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Start repeat transmission for a CAN frame through an IO session
#[tauri::command]
pub async fn io_start_repeat_transmit(
    app: AppHandle,
    session_id: String,
    queue_id: String,
    frame: CanTransmitFrame,
    interval_ms: u64,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    // Stop any existing repeat for this queue_id
    io_stop_repeat_transmit(queue_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let queue_id_for_task = queue_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        // Helper to emit history and check for stop
        let emit_and_check = |app: &AppHandle, result: &Result<crate::io::TransmitResult, String>, queue_id: &str| -> (bool, Option<String>) {
            let now_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros() as u64;

            let (success, timestamp_us, error) = match result {
                Ok(r) => (r.success, r.timestamp_us, r.error.clone()),
                Err(e) => (false, now_us, Some(e.clone())),
            };

            let event = TransmitHistoryEvent {
                session_id: session_id_clone.clone(),
                queue_id: queue_id.to_string(),
                frame: frame.clone(),
                success,
                timestamp_us,
                error: error.clone(),
            };
            let _ = app.emit("transmit-history", &event);

            (success, error)
        };

        // First transmit - do this before starting interval timer so startup delays
        // don't affect the regular interval timing
        if cancel_flag_clone.load(Ordering::Relaxed) {
            return;
        }

        let (result, should_stop) = do_transmit(&session_id_clone, &frame).await;
        let (_, error) = emit_and_check(&app, &result, &queue_id_for_task);

        if should_stop {
            let reason = error.unwrap_or_else(|| "Permanent error".to_string());
            eprintln!(
                "[io_transmit] Stopping repeat for '{}' due to permanent error: {}",
                queue_id_for_task, reason
            );
            let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                queue_id: queue_id_for_task.clone(),
                reason,
            });
            return;
        }

        // Now start the interval timer for subsequent transmits
        let mut interval_timer = tokio::time::interval(tokio::time::Duration::from_millis(interval_ms));
        // Skip the first tick which fires immediately
        interval_timer.tick().await;

        loop {
            // Wait for next interval tick first
            interval_timer.tick().await;

            // Check cancel flag
            if cancel_flag_clone.load(Ordering::Relaxed) {
                break;
            }

            // Transmit with retry for transient errors
            let (result, should_stop) = do_transmit(&session_id_clone, &frame).await;
            let (_, error) = emit_and_check(&app, &result, &queue_id_for_task);

            // Stop on permanent errors (device gone, session invalid)
            if should_stop {
                let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                eprintln!(
                    "[io_transmit] Stopping repeat for '{}' due to permanent error: {}",
                    queue_id_for_task, reason
                );
                // Notify frontend that repeat has stopped
                let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                    queue_id: queue_id_for_task.clone(),
                    reason,
                });
                break;
            }
        }
    });

    // Store the task
    let mut tasks = IO_REPEAT_TASKS.lock().await;
    tasks.insert(
        queue_id,
        IoRepeatTask {
            cancel_flag,
            handle,
        },
    );

    Ok(())
}

/// Stop repeat transmission for a queue item (IO session)
#[tauri::command]
pub async fn io_stop_repeat_transmit(queue_id: String) -> Result<(), String> {
    let mut tasks = IO_REPEAT_TASKS.lock().await;
    if let Some(task) = tasks.remove(&queue_id) {
        eprintln!("[io_transmit] Stopping repeat for queue_id '{}'", queue_id);
        task.cancel_flag.store(true, Ordering::Relaxed);
        // Don't await the handle - let it finish on its own after seeing cancel flag
    }
    Ok(())
}

/// Stop all repeat transmissions for an IO session
#[tauri::command]
pub async fn io_stop_all_repeats(_session_id: String) -> Result<(), String> {
    let mut tasks = IO_REPEAT_TASKS.lock().await;
    let queue_ids: Vec<String> = tasks.keys().cloned().collect();

    for queue_id in queue_ids {
        if let Some(task) = tasks.remove(&queue_id) {
            eprintln!(
                "[io_transmit] Stopping repeat for queue_id '{}' (stop all)",
                queue_id
            );
            task.cancel_flag.store(true, Ordering::Relaxed);
        }
    }

    Ok(())
}

// ============================================================================
// IO Session Serial Repeat Transmit
// ============================================================================

/// Start repeat transmission for serial bytes through an IO session
#[tauri::command]
pub async fn io_start_serial_repeat_transmit(
    app: AppHandle,
    session_id: String,
    queue_id: String,
    bytes: Vec<u8>,
    interval_ms: u64,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    if bytes.is_empty() {
        return Err("No bytes to transmit".to_string());
    }

    // Stop any existing repeat for this queue_id
    io_stop_repeat_transmit(queue_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let queue_id_for_task = queue_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        // Helper to emit history and check for stop
        let emit_and_check = |app: &AppHandle, result: &Result<crate::io::TransmitResult, String>, queue_id: &str| -> Option<String> {
            let now_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros() as u64;

            let (success, timestamp_us, error) = match result {
                Ok(r) => (r.success, r.timestamp_us, r.error.clone()),
                Err(e) => (false, now_us, Some(e.clone())),
            };

            let event = SerialTransmitHistoryEvent {
                session_id: session_id_clone.clone(),
                queue_id: queue_id.to_string(),
                bytes: bytes.clone(),
                success,
                timestamp_us,
                error: error.clone(),
            };
            let _ = app.emit("serial-transmit-history", &event);

            error
        };

        // First transmit - do this before starting interval timer so startup delays
        // don't affect the regular interval timing
        if cancel_flag_clone.load(Ordering::Relaxed) {
            return;
        }

        let (result, should_stop) = do_serial_transmit(&session_id_clone, &bytes).await;
        let error = emit_and_check(&app, &result, &queue_id_for_task);

        if should_stop {
            let reason = error.unwrap_or_else(|| "Permanent error".to_string());
            eprintln!(
                "[io_transmit] Stopping serial repeat for '{}' due to permanent error: {}",
                queue_id_for_task, reason
            );
            let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                queue_id: queue_id_for_task.clone(),
                reason,
            });
            return;
        }

        // Now start the interval timer for subsequent transmits
        let mut interval_timer = tokio::time::interval(tokio::time::Duration::from_millis(interval_ms));
        // Skip the first tick which fires immediately
        interval_timer.tick().await;

        loop {
            // Wait for next interval tick first
            interval_timer.tick().await;

            // Check cancel flag
            if cancel_flag_clone.load(Ordering::Relaxed) {
                break;
            }

            // Transmit with retry for transient errors
            let (result, should_stop) = do_serial_transmit(&session_id_clone, &bytes).await;
            let error = emit_and_check(&app, &result, &queue_id_for_task);

            // Stop on permanent errors (device gone, session invalid)
            if should_stop {
                let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                eprintln!(
                    "[io_transmit] Stopping serial repeat for '{}' due to permanent error: {}",
                    queue_id_for_task, reason
                );
                // Notify frontend that repeat has stopped
                let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                    queue_id: queue_id_for_task.clone(),
                    reason,
                });
                break;
            }
        }
    });

    // Store the task (uses same map as CAN repeats - queue_id is unique)
    let mut tasks = IO_REPEAT_TASKS.lock().await;
    tasks.insert(
        queue_id,
        IoRepeatTask {
            cancel_flag,
            handle,
        },
    );

    Ok(())
}

// ============================================================================
// IO Session Group Repeat Transmit
// ============================================================================
//
// Group repeat transmits multiple frames in sequence within a single loop.
// All frames in the group are sent one after another (no delay between them),
// then the system waits for the interval before repeating the sequence.

/// Map of group_id -> IoRepeatTask for active group repeat transmissions
static IO_REPEAT_GROUPS: Lazy<tokio::sync::Mutex<HashMap<String, IoRepeatTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Start repeat transmission for a group of CAN frames through an IO session.
/// Frames are sent sequentially (A→B→C) with no delay between them, then the
/// system waits for the interval before repeating the sequence.
#[tauri::command]
pub async fn io_start_repeat_group(
    app: AppHandle,
    session_id: String,
    group_id: String,
    frames: Vec<CanTransmitFrame>,
    interval_ms: u64,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    if frames.is_empty() {
        return Err("Group must contain at least one frame".to_string());
    }

    // Stop any existing repeat for this group
    io_stop_repeat_group(group_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let group_id_for_task = group_id.clone();

    let task_id = IO_REPEAT_TASK_COUNTER.fetch_add(1, Ordering::Relaxed);
    eprintln!(
        "[io_transmit] Starting group repeat task {} for group '{}', session '{}', {} frames, interval {}ms",
        task_id, group_id, session_id, frames.len(), interval_ms
    );

    let handle = tauri::async_runtime::spawn(async move {
        // Helper to emit history event and return error if any
        let emit_history = |app: &AppHandle, frame: &CanTransmitFrame, result: &Result<crate::io::TransmitResult, String>, group_id: &str| -> Option<String> {
            let now_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros() as u64;

            let (success, timestamp_us, error) = match result {
                Ok(r) => (r.success, r.timestamp_us, r.error.clone()),
                Err(e) => (false, now_us, Some(e.clone())),
            };

            let event = TransmitHistoryEvent {
                session_id: session_id_clone.clone(),
                queue_id: group_id.to_string(),
                frame: frame.clone(),
                success,
                timestamp_us,
                error: error.clone(),
            };
            let _ = app.emit("transmit-history", &event);

            error
        };

        // First group cycle - do this before starting interval timer so startup delays
        // don't affect the regular interval timing
        if cancel_flag_clone.load(Ordering::Relaxed) {
            return;
        }

        for frame in &frames {
            let (result, should_stop) = do_transmit(&session_id_clone, frame).await;
            let error = emit_history(&app, frame, &result, &group_id_for_task);

            if should_stop {
                let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                eprintln!(
                    "[io_transmit] Stopping group repeat for '{}' due to permanent error: {}",
                    group_id_for_task, reason
                );
                let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                    queue_id: group_id_for_task.clone(),
                    reason,
                });
                return;
            }
        }

        // Now start the interval timer for subsequent cycles
        let mut interval_timer = tokio::time::interval(tokio::time::Duration::from_millis(interval_ms));
        // Skip the first tick which fires immediately
        interval_timer.tick().await;

        'outer: loop {
            // Wait for next cycle first
            interval_timer.tick().await;

            // Check cancel flag before sending
            if cancel_flag_clone.load(Ordering::Relaxed) {
                break;
            }

            // Send all frames in sequence (no delays between them)
            for frame in &frames {
                // Transmit with retry for transient errors
                let (result, should_stop) = do_transmit(&session_id_clone, frame).await;
                let error = emit_history(&app, frame, &result, &group_id_for_task);

                // Stop on permanent errors (device gone, session invalid)
                if should_stop {
                    let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                    eprintln!(
                        "[io_transmit] Stopping group repeat for '{}' due to permanent error: {}",
                        group_id_for_task, reason
                    );
                    // Notify frontend that repeat has stopped
                    let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                        queue_id: group_id_for_task.clone(),
                        reason,
                    });
                    break 'outer;
                }
            }
        }
    });

    // Store the task
    let mut groups = IO_REPEAT_GROUPS.lock().await;
    groups.insert(
        group_id,
        IoRepeatTask {
            cancel_flag,
            handle,
        },
    );

    Ok(())
}

/// Stop repeat transmission for a group
#[tauri::command]
pub async fn io_stop_repeat_group(group_id: String) -> Result<(), String> {
    let mut groups = IO_REPEAT_GROUPS.lock().await;
    if let Some(task) = groups.remove(&group_id) {
        eprintln!("[io_transmit] Stopping group repeat for '{}'", group_id);
        task.cancel_flag.store(true, Ordering::Relaxed);
        // Don't await the handle - let it finish on its own after seeing cancel flag
    }
    Ok(())
}

/// Stop all group repeat transmissions
#[tauri::command]
pub async fn io_stop_all_group_repeats() -> Result<(), String> {
    let mut groups = IO_REPEAT_GROUPS.lock().await;
    let group_ids: Vec<String> = groups.keys().cloned().collect();

    for group_id in group_ids {
        if let Some(task) = groups.remove(&group_id) {
            eprintln!(
                "[io_transmit] Stopping group repeat for '{}' (stop all)",
                group_id
            );
            task.cancel_flag.store(true, Ordering::Relaxed);
        }
    }

    Ok(())
}

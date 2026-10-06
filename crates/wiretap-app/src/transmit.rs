// ui/crates/wiretap-app/src/transmit.rs
//
// Tauri commands for CAN frame and serial byte transmission.
//
// Transmission works through existing IO sessions (created by Discovery/Decoder or Transmit app).
// This approach avoids creating duplicate connections and integrates with the session model.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

use crate::io::periodic::Cadence;
use crate::io::{self, CanTransmitFrame, IOCapabilities, SignalThrottle};
use crate::settings::{load_settings, IOProfile};

// ============================================================================
// Types
// ============================================================================

/// Writer capabilities - what a transmit-capable profile supports
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct WriterCapabilities {
    pub can_transmit_can: bool,
    pub can_transmit_serial: bool,
}

/// Profile info with transmit capabilities
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TransmitProfile {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub capabilities: WriterCapabilities,
}

/// How serial bytes are framed on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SerialFraming {
    Raw,
    Slip,
    Delimiter { delimiter: Vec<u8> },
}

impl SerialFraming {
    fn frame(&self, payload: &[u8]) -> Vec<u8> {
        match self {
            Self::Raw => payload.to_vec(),
            Self::Slip => wiretap_protocol::slip::encode(payload),
            Self::Delimiter { delimiter } => [payload, delimiter].concat(),
        }
    }
}

/// Event payload for repeat stopped (emitted when repeat stops due to permanent error)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RepeatStoppedEvent {
    pub queue_id: String,
    pub reason: String,
}

/// Announces a repeat transmit that started, carrying everything the frontend
/// needs to render it as a queue row, so a human's repeat and an agent's share
/// one visible queue.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RepeatStartedEvent {
    pub queue_id: String,
    pub session_id: String,
    pub profile_id: String,
    pub profile_name: String,
    #[serde(flatten)]
    pub frame: CanTransmitFrame,
    pub interval_ms: u64,
    /// Where the repeat came from: `"user"` or `"agent"`.
    pub origin: String,
}

/// One session's run of frames within a repeat group.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RepeatGroupMember {
    pub session_id: String,
    pub frames: Vec<CanTransmitFrame>,
}

/// Announces a group repeat that started.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RepeatGroupStartedEvent {
    pub group_id: String,
}

// ============================================================================
// Helper Functions
// ============================================================================

fn writer_capabilities(profile: &IOProfile) -> WriterCapabilities {
    let traits = io::traits::profile_traits(profile);
    let unblocked = traits.tx_blocked.is_none();
    WriterCapabilities {
        can_transmit_can: unblocked && traits.session.tx_frames,
        can_transmit_serial: unblocked && traits.session.tx_bytes,
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
        if !crate::io::device_kinds::spec(&profile.kind).is_some_and(|s| s.available) {
            continue;
        }
        let capabilities = writer_capabilities(profile);
        if capabilities.can_transmit_can || capabilities.can_transmit_serial {
            profiles.push(TransmitProfile {
                id: profile.id.clone(),
                name: profile.name.clone(),
                kind: profile.kind.clone(),
                capabilities,
            });
        }
    }

    Ok(profiles)
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
    transmit_can(&session_id, &frame).await
}

/// One CAN transmit, recorded in the history, for the UI and the MCP agent alike.
pub async fn transmit_can(
    session_id: &str,
    frame: &CanTransmitFrame,
) -> Result<crate::io::TransmitResult, String> {
    let result = io::transmit_frame(session_id, frame).await;
    let (success, error) = match &result {
        Ok(r) => (r.success, r.error.as_deref()),
        Err(e) => (false, Some(e.as_str())),
    };
    crate::transmit_history::write_entry(
        session_id,
        "can",
        Some(frame.frame_id as i64),
        Some(frame.data.len() as i64),
        &frame.data,
        frame.bus as i64,
        frame.is_extended,
        frame.is_fd,
        success,
        error,
    );
    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
    result
}

/// Transmit serial bytes through an IO session, framed as `framing` says
#[tauri::command]
pub async fn io_transmit_serial(
    session_id: String,
    bytes: Vec<u8>,
    framing: SerialFraming,
) -> Result<crate::io::TransmitResult, String> {
    let bytes = framing.frame(&bytes);
    let result = io::transmit_serial(&session_id, &bytes).await;
    let (success, error) = match &result {
        Ok(r) => (r.success, r.error.as_deref()),
        Err(e) => (false, Some(e.as_str())),
    };
    crate::transmit_history::write_entry(
        &session_id, "serial",
        None, None,
        &bytes,
        0, false, false,
        success,
        error,
    );
    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
    result
}

/// Get IO session capabilities (includes transmit capabilities)
#[tauri::command]
pub async fn get_io_session_capabilities(session_id: String) -> Result<Option<IOCapabilities>, String> {
    Ok(io::get_session_capabilities(&session_id).await)
}

/// Change serial framing on a running session in place (no device reconnect).
/// Used by the Decoder when a serial catalogue is selected mid-stream so the
/// source starts SLIP-framing without a re-watch. Returns the updated capabilities.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn io_set_framing(
    session_id: String,
    encoding: crate::io::FramingMode,
    frame_id_start_byte: Option<i32>,
    frame_id_bytes: Option<u8>,
    frame_id_big_endian: Option<bool>,
    source_address_start_byte: Option<i32>,
    source_address_bytes: Option<u8>,
    source_address_big_endian: Option<bool>,
    min_frame_length: Option<usize>,
    modbus: Option<crate::io::ModbusRtuOptions>,
) -> Result<IOCapabilities, String> {
    let req = crate::io::types::SetFramingRequest {
        encoding,
        modbus,
        frame_id_start_byte,
        frame_id_bytes,
        frame_id_big_endian: frame_id_big_endian.unwrap_or(true),
        source_address_start_byte,
        source_address_bytes,
        source_address_big_endian: source_address_big_endian.unwrap_or(true),
        min_frame_length: min_frame_length.unwrap_or(0),
        // Keep raw bytes flowing (matches mergeSerialConfigForWatch).
        emit_raw_bytes: true,
    };
    io::set_framing(&session_id, req).await
}

// ============================================================================
// IO Session Repeat Transmit
// ============================================================================

/// Counter for generating unique repeat task IDs
static IO_REPEAT_TASK_COUNTER: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// Simple Transmit Helpers
// ============================================================================

/// Whether a refused transmit ends a repeat or replay: the session is gone, or
/// the device is.
pub(crate) async fn transmit_refusal_is_permanent(session_id: &str, error: &str) -> bool {
    !io::session_exists(session_id).await || is_permanent_error(error)
}

/// Check if a device error is permanent (should stop repeat) vs transient (can continue)
pub(crate) fn is_permanent_error(error: &str) -> bool {
    let error_lower = error.to_lowercase();
    error_lower.contains("disconnected")
        || error_lower.contains("does not support")
        || error_lower.contains("no device")
        || error_lower.contains("permission denied")
        || error_lower.contains("access denied")
        // Windows renders ERROR_ACCESS_DENIED as "Access is denied." — the "is"
        // means the "access denied" needle above never matches it.
        || error_lower.contains("access is denied")
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
            let should_stop = transmit_refusal_is_permanent(session_id, e).await;
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
            let should_stop = transmit_refusal_is_permanent(session_id, e).await;
            (result, should_stop)
        }
    }
}

/// Active repeat transmit task for IO sessions
struct IoRepeatTask {
    /// Cancel flag for the repeat loop
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Task handle
    #[cfg_attr(not(test), allow(dead_code))]
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
    start_repeat_transmit(&app, session_id, queue_id, frame, interval_ms, "user").await
}

/// Start a repeating CAN transmit and announce it as a queue row. `origin` is
/// `"user"` or `"agent"`, so the Transmit app can badge the row.
pub async fn start_repeat_transmit(
    app: &AppHandle,
    session_id: String,
    queue_id: String,
    frame: CanTransmitFrame,
    interval_ms: u64,
    origin: &str,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    // Stop any existing repeat for this queue_id
    io_stop_repeat_transmit(queue_id.clone()).await?;

    let profile_id = crate::sessions::get_session_profile_ids(&session_id)
        .into_iter()
        .next()
        .unwrap_or_default();
    let profile_name = crate::settings::profile_by_id(app, &profile_id)
        .map(|p| p.name)
        .unwrap_or_else(|_| profile_id.clone());
    let started = RepeatStartedEvent {
        queue_id: queue_id.clone(),
        session_id: session_id.clone(),
        profile_id,
        profile_name,
        frame: frame.clone(),
        interval_ms,
        origin: origin.to_string(),
    };

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let queue_id_for_task = queue_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let mut throttle = SignalThrottle::new();

        // Write this frame's transmit result to SQLite and throttle the UI notification.
        let write_and_notify = |result: &Result<crate::io::TransmitResult, String>, throttle: &mut SignalThrottle| -> (bool, Option<String>) {
            let (success, error) = match result {
                Ok(r) => (r.success, r.error.clone()),
                Err(e) => (false, Some(e.clone())),
            };
            crate::transmit_history::write_entry(
                &session_id_clone, "can",
                Some(frame.frame_id as i64),
                Some(frame.data.len() as i64),
                &frame.data,
                frame.bus as i64,
                frame.is_extended,
                frame.is_fd,
                success,
                error.as_deref(),
            );
            if throttle.should_signal("transmit-updated") {
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
            }
            (success, error)
        };

        // Fire immediately, then once per interval. Cadence handles the cancel
        // check; subsequent ticks aren't skewed by the first transmit's latency.
        let mut cadence = Cadence::new(interval_ms, cancel_flag_clone);
        while cadence.next().await.is_some() {
            let (result, should_stop) = do_transmit(&session_id_clone, &frame).await;
            let (_, error) = write_and_notify(&result, &mut throttle);

            // Stop on permanent errors (device gone, session invalid)
            if should_stop {
                let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                tlog!(
                    "[io_transmit] Stopping repeat for '{}' due to permanent error: {}",
                    queue_id_for_task, reason
                );
                crate::ws::dispatch::send_repeat_stopped(&RepeatStoppedEvent {
                    queue_id: queue_id_for_task.clone(),
                    reason,
                });
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
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
    drop(tasks);

    // Announced once the task is stored, so a stop the row prompts finds it.
    crate::ws::dispatch::send_repeat_started(&started);
    Ok(())
}

/// Stop repeat transmission for a queue item (IO session)
#[tauri::command]
pub async fn io_stop_repeat_transmit(queue_id: String) -> Result<(), String> {
    let mut tasks = IO_REPEAT_TASKS.lock().await;
    if let Some(task) = tasks.remove(&queue_id) {
        tlog!("[io_transmit] Stopping repeat for queue_id '{}'", queue_id);
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
            tlog!(
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
    session_id: String,
    queue_id: String,
    bytes: Vec<u8>,
    framing: SerialFraming,
    interval_ms: u64,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    if bytes.is_empty() {
        return Err("No bytes to transmit".to_string());
    }
    let bytes = framing.frame(&bytes);

    // Stop any existing repeat for this queue_id
    io_stop_repeat_transmit(queue_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let queue_id_for_task = queue_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let mut throttle = SignalThrottle::new();

        let write_and_notify = |result: &Result<crate::io::TransmitResult, String>, throttle: &mut SignalThrottle| -> Option<String> {
            let (success, error) = match result {
                Ok(r) => (r.success, r.error.clone()),
                Err(e) => (false, Some(e.clone())),
            };
            crate::transmit_history::write_entry(
                &session_id_clone, "serial",
                None, None,
                &bytes,
                0, false, false,
                success,
                error.as_deref(),
            );
            if throttle.should_signal("transmit-updated") {
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
            }
            error
        };

        // Fire immediately, then once per interval (see io_start_repeat_transmit).
        let mut cadence = Cadence::new(interval_ms, cancel_flag_clone);
        while cadence.next().await.is_some() {
            let (result, should_stop) = do_serial_transmit(&session_id_clone, &bytes).await;
            let error = write_and_notify(&result, &mut throttle);

            // Stop on permanent errors (device gone, session invalid)
            if should_stop {
                let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                tlog!(
                    "[io_transmit] Stopping serial repeat for '{}' due to permanent error: {}",
                    queue_id_for_task, reason
                );
                crate::ws::dispatch::send_repeat_stopped(&RepeatStoppedEvent {
                    queue_id: queue_id_for_task.clone(),
                    reason,
                });
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
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

/// Start repeating a group of CAN frames, which may span sessions. Each cycle
/// sends every member's frames in order with no delay between them, then waits
/// for the interval. A permanent refusal on any member stops the whole group.
#[tauri::command]
pub async fn io_start_repeat_group(
    group_id: String,
    members: Vec<RepeatGroupMember>,
    interval_ms: u64,
) -> Result<(), String> {
    if interval_ms < 1 {
        return Err("Interval must be at least 1ms".to_string());
    }

    if members.iter().all(|m| m.frames.is_empty()) {
        return Err("Group must contain at least one frame".to_string());
    }

    // Stop any existing repeat for this group
    io_stop_repeat_group(group_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let group_id_for_task = group_id.clone();

    let task_id = IO_REPEAT_TASK_COUNTER.fetch_add(1, Ordering::Relaxed);
    tlog!(
        "[io_transmit] Starting group repeat task {} for group '{}', {} members, interval {}ms",
        task_id, group_id, members.len(), interval_ms
    );

    let handle = tauri::async_runtime::spawn(async move {
        let mut throttle = SignalThrottle::new();

        // Write a CAN frame result to SQLite and throttle the UI notification.
        let write_frame = |session_id: &str, frame: &CanTransmitFrame, result: &Result<crate::io::TransmitResult, String>, throttle: &mut SignalThrottle| -> Option<String> {
            let (success, error) = match result {
                Ok(r) => (r.success, r.error.clone()),
                Err(e) => (false, Some(e.clone())),
            };
            crate::transmit_history::write_entry(
                session_id, "can",
                Some(frame.frame_id as i64),
                Some(frame.data.len() as i64),
                &frame.data,
                frame.bus as i64,
                frame.is_extended,
                frame.is_fd,
                success,
                error.as_deref(),
            );
            if throttle.should_signal("transmit-updated") {
                crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
            }
            error
        };

        // Fire the first cycle immediately, then one cycle per interval
        // (see io_start_repeat_transmit).
        let mut cadence = Cadence::new(interval_ms, cancel_flag_clone);
        'outer: while cadence.next().await.is_some() {
            for member in &members {
                for frame in &member.frames {
                    let (result, should_stop) = do_transmit(&member.session_id, frame).await;
                    let error = write_frame(&member.session_id, frame, &result, &mut throttle);

                    if should_stop {
                        let reason = error.unwrap_or_else(|| "Permanent error".to_string());
                        tlog!(
                            "[io_transmit] Stopping group repeat for '{}' due to permanent error: {}",
                            group_id_for_task, reason
                        );
                        crate::ws::dispatch::send_repeat_stopped(&RepeatStoppedEvent {
                            queue_id: group_id_for_task.clone(),
                            reason,
                        });
                        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
                        break 'outer;
                    }
                }
            }
        }
    });

    IO_REPEAT_GROUPS.lock().await.insert(
        group_id.clone(),
        IoRepeatTask {
            cancel_flag,
            handle,
        },
    );

    // Announced once the task is stored, so a stop the group prompts finds it.
    crate::ws::dispatch::send_repeat_group_started(&RepeatGroupStartedEvent { group_id });
    Ok(())
}

/// Stop repeat transmission for a group
#[tauri::command]
pub async fn io_stop_repeat_group(group_id: String) -> Result<(), String> {
    let mut groups = IO_REPEAT_GROUPS.lock().await;
    if let Some(task) = groups.remove(&group_id) {
        tlog!("[io_transmit] Stopping group repeat for '{}'", group_id);
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
            tlog!(
                "[io_transmit] Stopping group repeat for '{}' (stop all)",
                group_id
            );
            task.cancel_flag.store(true, Ordering::Relaxed);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_permanent_error, SerialFraming};

    fn framing(json: &str) -> SerialFraming {
        serde_json::from_str(json).expect("the framing the Transmit app sends")
    }

    #[test]
    fn raw_serial_goes_out_as_given() {
        assert_eq!(framing(r#"{"mode":"raw"}"#).frame(&[0xC0, 1]), [0xC0, 1]);
    }

    #[test]
    fn slip_wraps_in_end_bytes_and_escapes_them_inside() {
        let slip = framing(r#"{"mode":"slip"}"#);
        assert_eq!(
            slip.frame(&[1, 0xC0, 0xDB, 2]),
            [0xC0, 1, 0xDB, 0xDC, 0xDB, 0xDD, 2, 0xC0]
        );
    }

    #[test]
    fn a_delimiter_is_appended_once() {
        let crlf = framing(r#"{"mode":"delimiter","delimiter":[13,10]}"#);
        assert_eq!(crlf.frame(&[0x41, 0x0D]), [0x41, 0x0D, 0x0D, 0x0A]);
    }

    #[test]
    fn windows_access_denied_is_permanent() {
        // The exact string serialport surfaces on Windows ERROR_ACCESS_DENIED.
        assert!(is_permanent_error("Read error: Access is denied. (os error 5)"));
        assert!(is_permanent_error("Failed to open COM5: Access is denied."));
    }

    #[test]
    fn existing_permanent_needles_still_match() {
        assert!(is_permanent_error("Serial port disconnected"));
        assert!(is_permanent_error("Permission denied"));
    }

    #[test]
    fn transient_error_is_not_permanent() {
        assert!(!is_permanent_error("timed out"));
        assert!(!is_permanent_error("bus off"));
    }

    #[test]
    fn a_refusal_from_a_missing_session_is_permanent_whatever_it_says() {
        assert!(tauri::async_runtime::block_on(super::transmit_refusal_is_permanent("f_gone", "queue full")));
    }

    #[test]
    fn every_kind_whose_bus_transmits_is_offered_to_transmit() {
        for kind in crate::io::device_kinds::kinds() {
            let spec = crate::io::device_kinds::spec(kind).unwrap();
            let profile = crate::settings::IOProfile {
                kind: kind.to_string(),
                connection: serde_json::from_value(serde_json::json!({ "silent_mode": false, "listen_only": false })).unwrap(),
                ..Default::default()
            };
            let offered = super::writer_capabilities(&profile).can_transmit_can;
            assert_eq!(offered, spec.can_tx, "{kind}");
        }
    }

    #[test]
    fn a_listen_only_profile_is_not_offered_to_transmit() {
        for kind in ["slcan", "gs_usb"] {
            let profile = crate::settings::IOProfile { kind: kind.to_string(), ..Default::default() };
            assert!(!super::writer_capabilities(&profile).can_transmit_can, "{kind}");
        }
    }

    mod group {
        use super::super::{io_start_repeat_group, io_stop_repeat_group, RepeatGroupMember, IO_REPEAT_GROUPS};
        use crate::io::test_source::TestSource;
        use crate::io::{CanTransmitFrame, TransmitPayload, TransmitResult};
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        type Sent = Arc<Mutex<Vec<(String, u32)>>>;

        async fn open_recording(session_id: &str, sent: &Sent) {
            let sent = sent.clone();
            let source = TestSource::new(session_id).transmitting(move |session_id, payload| {
                if let TransmitPayload::CanFrame(frame) = payload {
                    sent.lock().unwrap().push((session_id.to_string(), frame.frame_id));
                }
                TransmitResult::success()
            });
            crate::io::create_session(session_id.into(), Box::new(source), None, None, None, vec![]).await;
            crate::io::start_session(session_id).await.unwrap();
        }

        fn member(session_id: &str, ids: &[u32]) -> RepeatGroupMember {
            RepeatGroupMember {
                session_id: session_id.into(),
                frames: ids
                    .iter()
                    .map(|&frame_id| CanTransmitFrame { frame_id, data: vec![0], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false })
                    .collect(),
            }
        }

        async fn until(mut done: impl FnMut() -> bool) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !done() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the group repeat never got there");
        }

        #[tokio::test]
        async fn one_group_repeats_across_two_sessions_in_its_order() {
            let sent = Sent::default();
            open_recording("f_group_a", &sent).await;
            open_recording("f_group_b", &sent).await;
            let members = vec![member("f_group_a", &[1]), member("f_group_b", &[2]), member("f_group_a", &[3])];

            io_start_repeat_group("g_two".into(), members, 10_000).await.unwrap();
            until(|| sent.lock().unwrap().len() >= 3).await;
            io_stop_repeat_group("g_two".into()).await.unwrap();

            let a = |id| ("f_group_a".to_string(), id);
            assert_eq!(*sent.lock().unwrap(), [a(1), ("f_group_b".to_string(), 2), a(3)]);
            for id in ["f_group_a", "f_group_b"] {
                crate::io::destroy_session(id, false).await.unwrap();
            }
        }

        #[tokio::test]
        async fn a_member_whose_session_is_gone_stops_the_whole_group() {
            let sent = Sent::default();
            open_recording("f_group_alive", &sent).await;
            let members = vec![member("f_group_missing", &[1]), member("f_group_alive", &[2])];

            io_start_repeat_group("g_gone".into(), members, 1).await.unwrap();
            until(|| IO_REPEAT_GROUPS.try_lock().is_ok_and(|g| g["g_gone"].handle.inner().is_finished())).await;

            assert!(sent.lock().unwrap().is_empty());
            io_stop_repeat_group("g_gone".into()).await.unwrap();
            crate::io::destroy_session("f_group_alive", false).await.unwrap();
        }

        #[tokio::test]
        async fn a_group_with_no_frames_is_refused() {
            let refused = io_start_repeat_group("g_empty".into(), vec![member("f_any", &[])], 10).await;
            assert!(refused.is_err());
        }
    }

    #[tokio::test]
    async fn a_transmit_refused_by_a_full_channel_is_recorded_as_failed() {
        crate::transmit_history::use_in_memory_database();
        let id = "f_channel_full";
        let source = crate::io::test_source::TestSource::new(id)
            .refusing("Transmit buffer full (sending on a full channel)");
        crate::io::create_session(id.into(), Box::new(source), None, None, None, vec![]).await;
        let frame = crate::io::CanTransmitFrame { frame_id: 0x100, data: vec![1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false };

        let refused = super::transmit_can(id, &frame).await.unwrap_err();

        let rows = crate::transmit_history::transmit_history_query(id.into(), 0, 10).unwrap();
        assert_eq!(rows.len(), 1, "the refusal never reached the history");
        assert!(!rows[0].success);
        assert_eq!(rows[0].error_msg.as_deref(), Some(refused.as_str()));
        crate::io::destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_serial_send_reaches_history() {
        crate::transmit_history::use_in_memory_database();
        let id = "b_serial_channel_full";
        let source = crate::io::test_source::TestSource::new(id).refusing("Serial transmit buffer full");
        crate::io::create_session(id.into(), Box::new(source), None, None, None, vec![]).await;

        let refused = super::io_transmit_serial(id.into(), vec![0x41], super::SerialFraming::Raw).await.unwrap_err();

        let rows = crate::transmit_history::transmit_history_query(id.into(), 0, 10).unwrap();
        assert_eq!(rows.len(), 1, "the refusal never reached the history");
        assert!(!rows[0].success);
        assert_eq!(rows[0].error_msg.as_deref(), Some(refused.as_str()));
        crate::io::destroy_session(id, false).await.unwrap();
    }
}

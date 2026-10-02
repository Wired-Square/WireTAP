// Copyright 2026 Wired Square Pty Ltd

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::{IOState, SessionMode, SessionTransition, StreamEndReason};

/// The Session Manager's own cap before the log moved here.
pub const SESSION_LOG_CAPACITY: usize = 500;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SessionLogEntry {
    /// Increases by one per entry for the life of the process; read the ring after it to catch up.
    pub id: u64,
    pub timestamp_ms: u64,
    pub session_id: Option<String>,
    pub profile_ids: Vec<String>,
    pub subscriber_id: Option<String>,
    pub app_name: Option<String>,
    pub event: SessionLogEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum SessionLogEvent {
    Created { mode: SessionMode, subscriber_count: usize },
    Joined { subscriber_count: usize },
    Left { subscriber_count: usize },
    Destroyed { reset: bool },
    State { state: IOState },
    Transitioned { transition: SessionTransition, mode: SessionMode },
    Speed { speed: f64 },
    Reconfigured,
    CaptureChanged,
    StreamEnded { reason: StreamEndReason, capture_count: Option<usize> },
    Error { message: String },
    DeviceConnected { source_type: String, address: String, bus: Option<u8> },
    DeviceProbe { source_type: String, address: String, success: bool, cached: bool, bus_count: u8, error: Option<String> },
    McpConnected { client: String },
    McpDisconnected { client: String },
    Stats { state: IOState, subscriber_count: usize, frame_count: usize },
    /// Everything before this entry was cleared.
    Cleared,
}

struct Ring {
    entries: VecDeque<SessionLogEntry>,
    next_id: u64,
}

impl Ring {
    const fn new() -> Self {
        Self { entries: VecDeque::new(), next_id: 1 }
    }

    fn push(&mut self, mut entry: SessionLogEntry) -> SessionLogEntry {
        if matches!(entry.event, SessionLogEvent::Cleared) {
            self.entries.clear();
        }
        entry.id = self.next_id;
        self.next_id += 1;
        if self.entries.len() == SESSION_LOG_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(entry.clone());
        entry
    }

    fn read(&self, after_id: Option<u64>, limit: Option<usize>) -> Vec<SessionLogEntry> {
        let newer: Vec<_> = self.entries.iter().filter(|e| after_id.is_none_or(|after| e.id > after)).collect();
        let skip = limit.map_or(0, |limit| newer.len().saturating_sub(limit));
        newer.into_iter().skip(skip).cloned().collect()
    }
}

static RING: Mutex<Ring> = Mutex::new(Ring::new());

fn ring() -> std::sync::MutexGuard<'static, Ring> {
    RING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Who an entry is about. A session's profiles are looked up unless given.
#[derive(Default)]
pub struct Subject<'a> {
    pub session_id: Option<&'a str>,
    pub profile_ids: Option<Vec<String>>,
    pub subscriber_id: Option<&'a str>,
    pub app_name: Option<&'a str>,
}

impl<'a> Subject<'a> {
    pub fn session(session_id: &'a str) -> Self {
        Self { session_id: Some(session_id), ..Self::default() }
    }
}

pub fn append(subject: Subject<'_>, event: SessionLogEvent) {
    let profile_ids = subject
        .profile_ids
        .unwrap_or_else(|| subject.session_id.map(crate::sessions::get_session_profile_ids).unwrap_or_default());
    let entry = ring().push(SessionLogEntry {
        id: 0,
        timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        session_id: subject.session_id.map(str::to_string),
        profile_ids,
        subscriber_id: subject.subscriber_id.map(str::to_string),
        app_name: subject.app_name.map(str::to_string),
        event,
    });
    crate::ws::dispatch::send_session_log_entry(&entry);
}

pub fn append_for_session(session_id: &str, event: SessionLogEvent) {
    append(Subject::session(session_id), event);
}

/// The retained entries after `after_id`, oldest first, at most the newest `limit`.
pub fn read(after_id: Option<u64>, limit: Option<usize>) -> Vec<SessionLogEntry> {
    ring().read(after_id, limit)
}

pub fn clear() {
    append(Subject::default(), SessionLogEvent::Cleared);
}

/// Sample every session into the log, at the interval the Session Manager setting asks for.
pub fn spawn_stats_sampler(app: tauri::AppHandle) {
    const DISABLED_RECHECK_SECS: u64 = 10;
    tauri::async_runtime::spawn(async move {
        loop {
            let secs = crate::settings::load_settings_sync(&app).map_or(0, |s| s.session_manager_stats_interval);
            tokio::time::sleep(std::time::Duration::from_secs(if secs == 0 { DISABLED_RECHECK_SECS } else { secs.into() }))
                .await;
            if secs == 0 {
                continue;
            }
            for session in super::list_sessions().await {
                append(
                    Subject { profile_ids: Some(session.source_profile_ids), ..Subject::session(&session.session_id) },
                    SessionLogEvent::Stats {
                        state: session.state,
                        subscriber_count: session.subscriber_count,
                        frame_count: session.capture_frame_count.unwrap_or(0),
                    },
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(event: SessionLogEvent) -> SessionLogEntry {
        SessionLogEntry {
            id: 0,
            timestamp_ms: 1,
            session_id: Some("f_1".into()),
            profile_ids: vec!["p1".into()],
            subscriber_id: None,
            app_name: None,
            event,
        }
    }

    #[test]
    fn the_ring_keeps_the_newest_entries_and_reads_after_an_id() {
        let mut ring = Ring::new();
        for _ in 0..SESSION_LOG_CAPACITY + 5 {
            ring.push(entry(SessionLogEvent::Reconfigured));
        }
        let all = ring.read(None, None);
        assert_eq!(all.len(), SESSION_LOG_CAPACITY);
        assert_eq!((all[0].id, all.last().unwrap().id), (6, SESSION_LOG_CAPACITY as u64 + 5));

        let last = all.last().unwrap().id;
        assert_eq!(ring.read(Some(last - 2), None).len(), 2);
        assert!(ring.read(Some(last), None).is_empty());
        assert_eq!(ring.read(None, Some(3)).iter().map(|e| e.id).collect::<Vec<_>>(), [last - 2, last - 1, last]);
    }

    #[test]
    fn a_clear_empties_the_ring_and_leaves_its_marker_without_reusing_ids() {
        let mut ring = Ring::new();
        ring.push(entry(SessionLogEvent::Reconfigured));
        ring.push(entry(SessionLogEvent::Cleared));
        assert_eq!(ring.read(None, None).iter().map(|e| (e.id, e.event.clone())).collect::<Vec<_>>(), [(2, SessionLogEvent::Cleared)]);
    }

    #[test]
    fn an_entry_serialises_with_its_kind_and_fields() {
        let ended = entry(SessionLogEvent::StreamEnded { reason: StreamEndReason::Disconnected, capture_count: Some(12) });
        let json = serde_json::to_value(&ended).unwrap();
        assert_eq!(json["event"], serde_json::json!({ "kind": "stream_ended", "reason": "disconnected", "capture_count": 12 }));
        let state = serde_json::to_value(SessionLogEvent::State { state: IOState::Error("x".into()) }).unwrap();
        assert_eq!(state, serde_json::json!({ "kind": "state", "state": { "type": "Error", "message": "x" } }));
        assert_eq!(serde_json::to_value(SessionLogEvent::Reconfigured).unwrap(), serde_json::json!({ "kind": "reconfigured" }));
    }
}

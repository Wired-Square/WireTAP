// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// src-tauri/src/io/post_session.rs

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

/// How long post-session data survives after storage
const TTL: Duration = Duration::from_secs(10);

/// Stream-ended info, persisted after session destruction for late-arriving fetches.
#[derive(Clone, Debug, Serialize)]
pub struct StreamEndedInfo {
    pub reason: String,
    pub capture_available: bool,
    pub capture_id: Option<String>,
    pub capture_kind: Option<String>,
    pub count: usize,
    pub time_range: Option<(u64, u64)>,
}

/// Connected source info for a session.
#[derive(Clone, Debug, Serialize)]
pub struct SourceInfo {
    pub device_type: String,
    pub address: String,
    pub bus: Option<u8>,
}

struct Entry {
    stream_ended: Option<StreamEndedInfo>,
    error: Option<String>,
    sources: Vec<SourceInfo>,
    orphaned_buffer_ids: Vec<String>,
    stored_at: Instant,
}

static CACHE: Lazy<RwLock<HashMap<String, Entry>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn get_or_create_entry<'a>(
    cache: &'a mut HashMap<String, Entry>,
    session_id: &str,
) -> &'a mut Entry {
    cache
        .entry(session_id.to_string())
        .or_insert_with(|| Entry {
            stream_ended: None,
            error: None,
            sources: Vec::new(),
            orphaned_buffer_ids: Vec::new(),
            stored_at: Instant::now(),
        })
}

pub fn store_stream_ended(session_id: &str, info: StreamEndedInfo) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.stream_ended = Some(info);
        entry.stored_at = Instant::now();
    }
}

pub fn store_error(session_id: &str, error: String) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.error = Some(error);
        entry.stored_at = Instant::now();
    }
}

pub fn store_source(session_id: &str, source: SourceInfo) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.sources.push(source);
        entry.stored_at = Instant::now();
    }
}

pub fn get_stream_ended(session_id: &str) -> Option<StreamEndedInfo> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .and_then(|e| e.stream_ended.clone())
        })
}

pub fn get_error(session_id: &str) -> Option<String> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .and_then(|e| e.error.clone())
        })
}

pub fn get_sources(session_id: &str) -> Vec<SourceInfo> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .map(|e| e.sources.clone())
        })
        .unwrap_or_default()
}

pub fn store_orphaned_capture_ids(session_id: &str, ids: Vec<String>) {
    if let Ok(mut cache) = CACHE.write() {
        let entry = get_or_create_entry(&mut cache, session_id);
        entry.orphaned_buffer_ids = ids;
        entry.stored_at = Instant::now();
    }
}

pub fn get_orphaned_capture_ids(session_id: &str) -> Vec<String> {
    CACHE
        .read()
        .ok()
        .and_then(|c| {
            c.get(session_id)
                .filter(|e| e.stored_at.elapsed() < TTL)
                .map(|e| e.orphaned_buffer_ids.clone())
        })
        .unwrap_or_default()
}

/// Remove expired entries. Call periodically (e.g., on session destroy).
pub fn sweep_expired() {
    if let Ok(mut cache) = CACHE.write() {
        cache.retain(|_, entry| entry.stored_at.elapsed() < TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_retrieve_stream_ended() {
        let sid = "ps_test_stream";
        store_stream_ended(
            sid,
            StreamEndedInfo {
                reason: "complete".into(),
                capture_available: true,
                capture_id: Some("buf1".into()),
                capture_kind: Some("frames".into()),
                count: 42,
                time_range: Some((1000, 2000)),
            },
        );
        let info = get_stream_ended(sid).unwrap();
        assert_eq!(info.reason, "complete");
        assert_eq!(info.count, 42);
    }

    #[test]
    fn store_and_retrieve_error() {
        let sid = "ps_test_err";
        store_error(sid, "broke".into());
        assert_eq!(get_error(sid), Some("broke".into()));
    }

    #[test]
    fn store_and_retrieve_sources() {
        let sid = "ps_test_src";
        store_source(
            sid,
            SourceInfo {
                device_type: "gs_usb".into(),
                address: "USB1".into(),
                bus: Some(0),
            },
        );
        let sources = get_sources(sid);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].device_type, "gs_usb");
    }

    #[test]
    fn missing_session_returns_none() {
        assert!(get_stream_ended("nonexistent_ps").is_none());
        assert!(get_error("nonexistent_ps").is_none());
        assert!(get_sources("nonexistent_ps").is_empty());
    }
}

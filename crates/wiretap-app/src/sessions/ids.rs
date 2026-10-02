use crate::{
    capture_store,
    io::{self, Protocol},
    settings::{AppSettings, IOProfile},
};
#[cfg(not(target_os = "ios"))]
use crate::io::device_kinds;

/// What a new session is for: the one thing its id's prefix says.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "purpose", rename_all = "snake_case")]
pub enum SessionPurpose {
    /// Profiles or stored captures; the prefix follows what they are.
    Sources {
        profile_ids: Vec<String>,
        #[cfg_attr(test, ts(optional))]
        emit_raw_bytes: Option<bool>,
    },
    /// Files imported into a new capture.
    Ingest,
    /// A Modbus register or unit-id sweep.
    ModbusScan,
}

pub(crate) const MODBUS_SCAN_SESSION_PREFIX: &str = "m_scan";

/// A fresh id, re-drawn while a live session or a capture's owner holds it.
pub(crate) async fn mint_session_id(prefix: &str) -> String {
    let live = io::session_ids().await;
    draw_session_id(prefix, random_suffix, |id| {
        live.contains(id) || capture_store::is_session_owner(id)
    })
}

const MINT_ATTEMPTS: usize = 16;

/// Gives up after `MINT_ATTEMPTS` with the last draw rather than failing the open.
fn draw_session_id(prefix: &str, mut suffix: impl FnMut() -> u64, taken: impl Fn(&str) -> bool) -> String {
    let mut id = String::new();
    for _ in 0..MINT_ATTEMPTS {
        id = format!("{prefix}_{:06x}", suffix() & 0xFF_FFFF);
        if !taken(&id) {
            break;
        }
    }
    id
}

fn random_suffix() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    );
    hasher.finish()
}

/// The session open on `source_id` alone, else a fresh id to open it under. The one
/// place a saved profile or capture is turned into a session id.
pub(crate) async fn session_for_source(source_id: &str, settings: &AppSettings) -> String {
    let live = io::session_ids().await;
    let mut open: Vec<String> = super::get_sessions_for_profile(source_id)
        .into_iter()
        .filter(|id| live.contains(id) && super::get_session_profile_ids(id) == [source_id])
        .collect();
    open.sort();
    match open.into_iter().next() {
        Some(id) => id,
        None => mint_session_id(sources_prefix(&[source_id.to_string()], settings, None)).await,
    }
}

/// A stored capture replays under `c`; otherwise the profiles decide.
pub(super) fn sources_prefix(
    profile_ids: &[String],
    settings: &AppSettings,
    emit_raw_bytes: Option<bool>,
) -> &'static str {
    if profile_ids.iter().any(|id| capture_store::is_known_capture(id)) {
        return "c";
    }
    session_id_prefix(
        profile_ids.iter().filter_map(|id| settings.profile(id).ok()),
        emit_raw_bytes,
    )
}

/// Modbus anywhere wins (`m`); otherwise the first resolvable profile decides:
/// recorded `t`, raw serial `b`, CAN or framed serial `f`, anything else `s`.
///
/// Whether a serial source emits bytes is resolved here rather than taken from
/// the caller: the frontend does not know a profile's framing before the session
/// exists, so it always said `false` and every raw serial session came out `f_`.
/// An explicit `emit_raw_bytes` still wins — the picker's "Capture raw bytes"
/// puts bytes on a framed link.
pub(crate) fn session_id_prefix<'a>(
    profiles: impl IntoIterator<Item = &'a IOProfile>,
    emit_raw_bytes: Option<bool>,
) -> &'static str {
    let mut first: Option<(bool, Option<Protocol>)> = None;
    let mut emits_bytes = false;
    for p in profiles {
        let spec = device_kinds::spec(&p.kind);
        let proto = spec.filter(|s| s.realtime).map(|s| s.protocol);
        if proto == Some(Protocol::Serial) {
            emits_bytes |= device_kinds::resolve_serial_framing(p, None, emit_raw_bytes).1;
        }
        if proto == Some(Protocol::Modbus) {
            return "m";
        }
        first.get_or_insert((spec.is_some_and(|s| !s.realtime), proto));
    }
    match first {
        Some((true, _)) => "t",
        Some((_, Some(Protocol::Serial))) if emits_bytes => "b",
        Some((_, Some(Protocol::Can | Protocol::Serial))) => "f",
        _ => "s",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::profile;
    use serde_json::json;

    #[test]
    fn session_id_prefixes_follow_the_kind_table() {
        let p = |kind: &str| profile(kind, json!({}));
        assert_eq!(session_id_prefix([&p("gvret_tcp")], None), "f");
        assert_eq!(session_id_prefix([&p("serial")], None), "b");
        assert_eq!(session_id_prefix([&p("gvret_tcp"), &p("modbus_tcp")], None), "m");
        assert_eq!(session_id_prefix([&p("wiretap"), &p("gvret_tcp")], None), "t");
        assert_eq!(session_id_prefix([&p("no_such_kind")], None), "s");
        assert_eq!(session_id_prefix([], None), "s");
    }

    /// The spellings the retired frontend mints used, and where one changed:
    /// capture replay was `b_`, which is raw serial's.
    #[test]
    fn every_purpose_mints_its_prefix() {
        let settings = AppSettings {
            io_profiles: vec![profile("wiretap", json!({}))],
            ..AppSettings::default()
        };
        let capture = capture_store::create_standalone_capture(
            crate::capture_store::CaptureKind::Frames,
            "replay".to_string(),
        );
        let ids = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let recorded = settings.io_profiles[0].id.clone();
        assert_eq!(sources_prefix(&ids(&[&recorded]), &settings, None), "t");
        assert_eq!(sources_prefix(&ids(&[&capture]), &settings, None), "c");
        assert_eq!(sources_prefix(&ids(&["unsaved"]), &settings, None), "s");

        let id = draw_session_id(MODBUS_SCAN_SESSION_PREFIX, random_suffix, |_| false);
        let (prefix, suffix) = id.rsplit_once('_').unwrap();
        assert_eq!(prefix, "m_scan");
        assert!(suffix.len() == 6 && suffix.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
    }

    #[test]
    fn a_taken_id_is_redrawn_and_the_retries_are_bounded() {
        let mut draws = [0x1, 0x1_000001, 0x2].into_iter();
        let id = draw_session_id("f", || draws.next().unwrap(), |id| id == "f_000001");
        assert_eq!(id, "f_000002", "the high bits are dropped, so the second draw collides too");

        let mut calls = 0;
        draw_session_id("f", || { calls += 1; 7 }, |_| true);
        assert_eq!(calls, MINT_ATTEMPTS);
    }

    #[tokio::test]
    async fn a_source_resolves_to_the_session_open_on_it_alone_else_to_a_new_id() {
        use crate::io::{create_session, destroy_session, test_source::TestSource};
        let settings = AppSettings::default();
        let (alone, merged) = ("f_source_alone", "f_source_merged");
        for id in [alone, merged] {
            create_session(id.into(), Box::new(TestSource::new(id)), None, None, None, vec![]).await;
        }
        super::super::register_session_profile(alone, "p-source-alone");
        super::super::register_session_profiles(merged, &["p-source-merged".into(), "p-other".into()]);

        assert_eq!(session_for_source("p-source-alone", &settings).await, alone);
        let fresh = session_for_source("p-source-merged", &settings).await;
        assert!(fresh.starts_with("s_") && fresh != merged, "{fresh}");
        for id in [alone, merged] {
            destroy_session(id, false).await.unwrap();
        }
    }

    #[test]
    fn a_purpose_reads_the_shape_the_frontend_sends() {
        let parse = |v| serde_json::from_value::<SessionPurpose>(v).ok();
        assert!(matches!(
            parse(json!({ "purpose": "sources", "profile_ids": ["a"], "emit_raw_bytes": true })),
            Some(SessionPurpose::Sources { emit_raw_bytes: Some(true), .. })
        ));
        assert!(matches!(
            parse(json!({ "purpose": "sources", "profile_ids": [] })),
            Some(SessionPurpose::Sources { emit_raw_bytes: None, .. })
        ));
        assert!(matches!(parse(json!({ "purpose": "ingest" })), Some(SessionPurpose::Ingest)));
        assert!(matches!(parse(json!({ "purpose": "modbus_scan" })), Some(SessionPurpose::ModbusScan)));
    }
}

// Copyright 2026 Wired Square Pty Ltd
//
// Backend view of the shared app registry (`src/apps/apps.json`) — the single
// source of truth for panel ids. Only the fields the backend needs are parsed;
// serde ignores the rest. The file is compile-time-embedded, so it is parsed
// once into a static.

use once_cell::sync::Lazy;
use serde::Deserialize;

const APPS_JSON: &str = include_str!("../../src/apps/apps.json");

#[derive(Deserialize)]
struct Registry {
    apps: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    id: String,
    #[serde(default, rename = "sessionAware")]
    session_aware: bool,
}

/// Panel ids declaring `sessionAware: true`, in apps.json order — the tabs a
/// session can be attached to. Parsed once.
static SESSION_AWARE_PANEL_IDS: Lazy<Vec<String>> = Lazy::new(|| {
    serde_json::from_str::<Registry>(APPS_JSON)
        .map(|r| {
            r.apps
                .into_iter()
                .filter(|a| a.session_aware)
                .map(|a| a.id)
                .collect()
        })
        .unwrap_or_default()
});

/// The source-aware panel ids (apps.json order).
pub fn session_aware_panel_ids() -> &'static [String] {
    &SESSION_AWARE_PANEL_IDS
}

/// Whether `panel` is a source-aware tab (per apps.json).
pub fn is_session_aware_panel(panel: &str) -> bool {
    SESSION_AWARE_PANEL_IDS.iter().any(|id| id == panel)
}

// crates/wiretap-app/src/capture_events.rs
//
// Events — a moment (or a span) and a note, owned by the stored capture: a
// local SQLite capture keeps its own rows, a WireTAP Backend profile's
// database keeps them on the gateway. Every mutation broadcasts
// `capture-events-changed` with the owner so each window refreshes.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{apiclient, capture_db};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEvent {
    pub id: String,
    pub timestamp_us: i64,
    pub duration_us: i64,
    pub note: String,
    pub created_at_us: i64,
    pub updated_at_us: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventOwner {
    Capture { capture_id: String },
    Backend { profile_id: String },
}

const CHANGED_EVENT: &str = "capture-events-changed";

#[tauri::command]
pub async fn capture_events_list(app: AppHandle, owner: EventOwner) -> Result<Vec<CaptureEvent>, String> {
    match &owner {
        EventOwner::Capture { capture_id } => capture_db::list_capture_events(capture_id),
        EventOwner::Backend { profile_id } => apiclient::events_list(&app, profile_id).await,
    }
}

#[tauri::command]
pub async fn capture_events_add(
    app: AppHandle,
    owner: EventOwner,
    timestamp_us: i64,
    duration_us: i64,
    note: String,
) -> Result<CaptureEvent, String> {
    let event = match &owner {
        EventOwner::Capture { capture_id } => {
            capture_db::insert_capture_event(capture_id, timestamp_us, duration_us, &note)
        }
        EventOwner::Backend { profile_id } => {
            apiclient::events_add(&app, profile_id, timestamp_us, duration_us, &note).await
        }
    }?;
    let _ = app.emit(CHANGED_EVENT, &owner);
    Ok(event)
}

#[tauri::command]
pub async fn capture_events_update(
    app: AppHandle,
    owner: EventOwner,
    id: String,
    timestamp_us: i64,
    duration_us: i64,
    note: String,
) -> Result<CaptureEvent, String> {
    let event = match &owner {
        EventOwner::Capture { capture_id } => {
            capture_db::update_capture_event(capture_id, &id, timestamp_us, duration_us, &note)
        }
        EventOwner::Backend { profile_id } => {
            apiclient::events_update(&app, profile_id, &id, timestamp_us, duration_us, &note).await
        }
    }?;
    let _ = app.emit(CHANGED_EVENT, &owner);
    Ok(event)
}

#[tauri::command]
pub async fn capture_events_delete(app: AppHandle, owner: EventOwner, id: String) -> Result<(), String> {
    match &owner {
        EventOwner::Capture { capture_id } => capture_db::delete_capture_event(capture_id, &id),
        EventOwner::Backend { profile_id } => apiclient::events_delete(&app, profile_id, &id).await,
    }?;
    let _ = app.emit(CHANGED_EVENT, &owner);
    Ok(())
}

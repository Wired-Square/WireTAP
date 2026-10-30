// Copyright 2026 Wired Square Pty Ltd

//! WS dispatch surface for SMP/OTA. `list_images`, `ota_cancel`, and a
//! fire-and-forget `ota_start` that drives `Discovery::ota_on_cancellable`
//! and pumps each `OtaEvent` onto the global WS channel as
//! `MsgType::OtaEvent`.
//!
//! Single OTA at a time. A second `ota_start` while one is in flight
//! returns an error.

use crate::device_scan::{discovery_handle, resolve_device_id};
use crate::ws::dispatch::send_ota_event;
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use wslib_framelink::{
    CancelOutcome, ImageSlot as FlImageSlot, OtaCancel, OtaEvent, OtaOptions, OtaStream, Transport,
};

/// Set when an OTA is in flight; gates concurrent `ota_start` calls.
static OTA_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears `OTA_IN_FLIGHT` on drop. Holds the in-flight slot for the
/// lifetime of the spawned pump task — even if the task panics or is
/// dropped before completing, the slot is released.
struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        OTA_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// The running update's cancel handle, and what a cancel of it decided.
/// `ota_cancel` holds the lock until the update has stopped, so the pump,
/// which locks it once the stream ends, names the right terminator.
#[derive(Default)]
struct CancelSlot {
    handle: Option<OtaCancel>,
    outcome: Option<OtaCancelOutcome>,
}

static OTA_CANCEL: Lazy<Mutex<CancelSlot>> = Lazy::new(Default::default);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum OtaCancelOutcome {
    Cancelled,
    /// The device has been asked to test the image; the update carries on.
    TooLate,
}

impl From<CancelOutcome> for OtaCancelOutcome {
    fn from(outcome: CancelOutcome) -> Self {
        match outcome {
            CancelOutcome::Cancelled => Self::Cancelled,
            // An outcome this build doesn't know can't be taken to have stopped the update.
            _ => Self::TooLate,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ImageSlotInfo {
    pub slot: i32,
    pub version: String,
    pub hash: String,
    pub bootable: bool,
    pub pending: bool,
    pub confirmed: bool,
    pub active: bool,
    pub permanent: bool,
    pub image: Option<i32>,
}

#[derive(Deserialize)]
struct ListImagesParams {
    device_id: String,
    transport: TransportArg,
}

#[derive(Deserialize)]
struct OtaStartParams {
    device_id: String,
    transport: TransportArg,
    /// Path to the firmware .bin on the local filesystem.
    file_path: PathBuf,
    /// Failsafe seconds to wait for the device to reappear in
    /// discovery after reset. Defaults to `OtaOptions::default()`.
    reconnect_timeout_secs: Option<u32>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TransportArg {
    Ble,
    Udp,
}

impl From<TransportArg> for Transport {
    fn from(t: TransportArg) -> Self {
        match t {
            TransportArg::Ble => Transport::Ble,
            TransportArg::Udp => Transport::Udp,
        }
    }
}

fn map_image_slot(s: FlImageSlot) -> ImageSlotInfo {
    ImageSlotInfo {
        slot: s.slot,
        version: s.version,
        hash: hex::encode(&s.hash),
        bootable: s.bootable,
        pending: s.pending,
        confirmed: s.confirmed,
        active: s.active,
        permanent: s.permanent,
        image: s.image.map(i32::from),
    }
}

pub async fn dispatch(
    op: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match op {
        "smp.list_images" => list_images(params).await,
        "smp.ota_start"   => ota_start(params).await,
        "smp.ota_cancel"  => ota_cancel().await,
        _                 => Err(format!("Unknown smp op: {op}")),
    }
}

async fn list_images(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let p: ListImagesParams = serde_json::from_value(params)
        .map_err(|e| format!("invalid list_images params: {e}"))?;
    let id = resolve_device_id(&p.device_id, p.transport.into()).await?;
    let discovery = discovery_handle().await?;
    let session = discovery
        .open_smp_on(&id, p.transport.into())
        .await
        .map_err(|e| format!("open_smp: {e}"))?;
    let images = session
        .list_images()
        .await
        .map_err(|e| format!("list_images: {e}"))?;
    let mapped: Vec<ImageSlotInfo> = images.into_iter().map(map_image_slot).collect();
    serde_json::to_value(mapped).map_err(|e| format!("serialise: {e}"))
}

async fn ota_start(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let p: OtaStartParams = serde_json::from_value(params)
        .map_err(|e| format!("invalid ota_start params: {e}"))?;
    if OTA_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return Err("an OTA is already in flight".into());
    }
    // Guard now owns the flag — every early return below restores it.
    let guard = InFlightGuard;

    let bytes: std::sync::Arc<[u8]> = std::fs::read(&p.file_path)
        .map_err(|e| format!("read firmware: {e}"))?
        .into();
    let id = resolve_device_id(&p.device_id, p.transport.into()).await?;
    let options = p
        .reconnect_timeout_secs
        .map(|secs| OtaOptions::default().with_reconnect_timeout(Duration::from_secs(secs.into())))
        .unwrap_or_default();
    let discovery = discovery_handle().await?;

    // Drop any cached session for this device so the OTA opens a fresh
    // SMP session — the cached session can outlive the underlying BLE
    // link if macOS dropped it during an idle window between operations
    // (e.g. between list_images and start OTA).
    discovery.release_device(&id).await;

    let (stream, cancel) = discovery.ota_on_cancellable(&id, bytes, options, p.transport.into());
    *OTA_CANCEL.lock().await = CancelSlot { handle: Some(cancel), outcome: None };
    tokio::spawn(async move {
        let _guard = guard;
        send_ota_event(&pump(stream).await);
    });

    Ok(serde_json::json!({}))
}

/// Forwards the update's events and returns its terminator.
async fn pump(mut stream: OtaStream) -> serde_json::Value {
    let ended = loop {
        match stream.next().await {
            Some(Ok(ev)) => send_ota_event(&serialise_event(&ev)),
            Some(Err(e)) => break serde_json::json!({ "type": "Error", "message": e.to_string() }),
            None => break serde_json::json!({ "type": "Complete" }),
        }
    };
    let slot = std::mem::take(&mut *OTA_CANCEL.lock().await);
    match slot.outcome {
        Some(OtaCancelOutcome::Cancelled) => serde_json::json!({ "type": "Cancelled" }),
        _ => ended,
    }
}

async fn ota_cancel() -> Result<serde_json::Value, String> {
    let mut slot = OTA_CANCEL.lock().await;
    let outcome = match slot.handle.take() {
        Some(handle) => OtaCancelOutcome::from(handle.cancel().await),
        None => slot.outcome.ok_or("no firmware update is running")?,
    };
    slot.outcome = Some(outcome);
    serde_json::to_value(outcome).map_err(|e| format!("serialise: {e}"))
}

/// Map an `OtaEvent` to a JSON object the frontend can decode without
/// needing to know the Rust enum's shape.
fn serialise_event(ev: &OtaEvent) -> serde_json::Value {
    match ev {
        OtaEvent::SessionOpened => serde_json::json!({ "type": "SessionOpened" }),
        OtaEvent::UploadProgress(p) => serde_json::json!({
            "type": "UploadProgress",
            "bytes_sent": p.bytes_sent,
            "total_bytes": p.total_bytes,
            "percent": p.percent(),
            "image_hash": p.image_hash.as_ref().map(hex::encode),
        }),
        OtaEvent::Activating => serde_json::json!({ "type": "Activating" }),
        OtaEvent::Activated { hash } => serde_json::json!({
            "type": "Activated",
            "hash": hex::encode(hash),
        }),
        OtaEvent::Resetting => serde_json::json!({ "type": "Resetting" }),
        OtaEvent::ResetSent => serde_json::json!({ "type": "ResetSent" }),
        OtaEvent::Reconnecting { name } => serde_json::json!({
            "type": "Reconnecting",
            "name": name,
        }),
        OtaEvent::Reconnected { device_id } => serde_json::json!({
            "type": "Reconnected",
            "device_id": device_id.as_str(),
        }),
        OtaEvent::Verified { active_hash } => serde_json::json!({
            "type": "Verified",
            "active_hash": hex::encode(active_hash),
        }),
        OtaEvent::Confirming => serde_json::json!({ "type": "Confirming" }),
        OtaEvent::Confirmed => serde_json::json!({ "type": "Confirmed" }),
        other => {
            tlog!("[smp] unknown OTA event: {other:?}");
            serde_json::json!({
                "type": "Unknown",
                "event": serde_json::to_value(other).unwrap_or_default(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;

    #[tokio::test]
    async fn a_cancel_stops_the_update_and_ends_it_as_cancelled() {
        assert!(ota_cancel().await.is_err());

        let silent_device = UdpSocket::bind("127.0.0.1:0").unwrap();
        let (stream, cancel) = wslib_framelink::ota_udp_addr_cancellable(
            silent_device.local_addr().unwrap(),
            "silent".into(),
            std::sync::Arc::from(vec![0u8; 64]),
            OtaOptions::default(),
        );
        *OTA_CANCEL.lock().await = CancelSlot { handle: Some(cancel), outcome: None };
        let terminator = tokio::spawn(pump(stream));

        assert_eq!(ota_cancel().await.unwrap(), "cancelled");
        assert_eq!(terminator.await.unwrap()["type"], "Cancelled");
        assert!(ota_cancel().await.is_err());
    }
}

// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

//! WS dispatch surface for SMP/OTA. Two read-only RPCs (`list_images`,
//! `ota_cancel`) and one fire-and-forget `ota_start` that drives
//! `framelink::Discovery::ota_ble`/`ota_udp` and pumps each `OtaEvent`
//! onto the global WS channel as `MsgType::OtaEvent`.
//!
//! Single OTA at a time. A second `ota_start` while one is in flight
//! returns an error.

use crate::device_scan::{discovery_handle, resolve_device_id};
use crate::ws::dispatch::send_ota_event;
use framelink::{ImageSlot as FlImageSlot, OtaEvent, OtaOptions, Transport};
use futures::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

/// Set when an OTA is in flight; gates concurrent `ota_start` calls.
static OTA_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears `OTA_IN_FLIGHT` on drop. Holds the in-flight slot for the lifetime
/// of the spawned pump task — even if the task panics or is dropped before
/// completing, the slot is released.
struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        OTA_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// Cancel signal. `ota_cancel` notifies; the OTA pump task selects
/// against it and bails on notify.
static OTA_CANCEL: Lazy<Notify> = Lazy::new(Notify::new);

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
    /// discovery after reset. Default 30.
    reconnect_timeout_secs: Option<u32>,
}

#[derive(Deserialize)]
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
        image: s.image,
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
    let transport = Transport::from(p.transport);
    let id = resolve_device_id(&p.device_id, transport).await?;
    let discovery = discovery_handle().await?;
    let session = match transport {
        Transport::Ble => discovery
            .open_smp_ble(&id)
            .await
            .map_err(|e| format!("open_smp_ble: {e}"))?,
        Transport::Udp => discovery
            .open_smp_udp(&id)
            .await
            .map_err(|e| format!("open_smp_udp: {e}"))?,
        Transport::Tcp => return Err("SMP over Tcp transport is not supported".into()),
    };
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
    let transport = Transport::from(p.transport);
    let id = resolve_device_id(&p.device_id, transport).await?;
    let options = OtaOptions {
        reconnect_timeout: Duration::from_secs(p.reconnect_timeout_secs.unwrap_or(30) as u64),
    };
    let discovery = discovery_handle().await?;

    // Drop any cached session for this device so the OTA opens a fresh
    // SMP session — the cached session can outlive the underlying BLE
    // link if macOS dropped it during an idle window between operations
    // (e.g. between list_images and start OTA).
    discovery.release_device(&id).await;

    tokio::spawn(async move {
        let _guard = guard;
        let mut stream: std::pin::Pin<
            Box<dyn futures::Stream<Item = Result<OtaEvent, framelink::SmpError>> + Send>,
        > = match transport {
            Transport::Ble => Box::pin(discovery.ota_ble(&id, bytes, options)),
            Transport::Udp => Box::pin(discovery.ota_udp(&id, bytes, options)),
            Transport::Tcp => {
                send_ota_event(&serde_json::json!({
                    "type": "Error",
                    "message": "SMP over Tcp transport is not supported",
                }));
                return;
            }
        };
        loop {
            tokio::select! {
                biased;
                _ = OTA_CANCEL.notified() => {
                    send_ota_event(&serde_json::json!({ "type": "Cancelled" }));
                    break;
                }
                next = stream.next() => match next {
                    Some(Ok(ev)) => send_ota_event(&serialize_event(&ev)),
                    Some(Err(e)) => {
                        send_ota_event(&serde_json::json!({
                            "type": "Error",
                            "message": e.to_string(),
                        }));
                        break;
                    }
                    None => {
                        send_ota_event(&serde_json::json!({ "type": "Complete" }));
                        break;
                    }
                }
            }
        }
    });

    Ok(serde_json::json!({}))
}

async fn ota_cancel() -> Result<serde_json::Value, String> {
    OTA_CANCEL.notify_waiters();
    Ok(serde_json::json!({}))
}

/// Map a `framelink::OtaEvent` to a JSON object the frontend can decode
/// without needing to know the Rust enum's bincode shape.
fn serialize_event(ev: &OtaEvent) -> serde_json::Value {
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
    }
}

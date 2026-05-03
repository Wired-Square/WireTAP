// Unified device scan module
//
// Drives `framelink::Discovery` — one handle that scans BLE + mDNS in
// parallel, decodes FrameLink manufacturer data, and emits `Seen /
// Updated / Lost / Error` events. We translate those into the
// `UnifiedDevice` payload that the frontend already consumes via
// `device-discovered`.
//
// The same `Discovery` handle is reused by `ble_provision` and
// `smp_upgrade` to open WiFi-prov / SMP sessions — that's why it lives
// here behind `discovery_handle()` rather than inside one of the
// per-feature modules. Sessions opened on the same device share one
// BLE link (refcounted inside framelink).

use framelink::{
    Capability, Device, DeviceId, Discovery, DiscoveryEvent, Transport,
};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use futures::StreamExt;

// ============================================================================
// Types
// ============================================================================

/// A discovered device with its capabilities (which services it advertises).
///
/// Wire-compatible with what the frontend already deserialises. `id` is now
/// the framelink-assigned `DeviceId` (`ble:{btleplug_id}` /
/// `mdns:{tcp|udp}:{fullname}`); for the BLE case `ble_id` carries the
/// legacy unprefixed btleplug id so older frontend code that read it keeps
/// working.
#[derive(Clone, Serialize)]
pub struct UnifiedDevice {
    pub name: String,
    pub id: String,
    /// "ble" | "tcp" | "udp"
    pub transport: String,
    pub ble_id: Option<String>,
    pub rssi: Option<i16>,
    pub address: Option<String>,
    pub port: Option<u16>,
    /// "wifi-provision" | "smp" | "framelink"
    pub capabilities: Vec<String>,
}

// ============================================================================
// Shared Discovery handle
// ============================================================================

struct DiscoveryState {
    /// Process-wide `Discovery` instance. Lazily created on the first
    /// `discovery_handle()` call (which may be a `device_scan_start` from
    /// the UI or an `open_*` from `ble_provision` / `smp_upgrade`); held
    /// for the rest of the process.
    discovery: Option<Discovery>,
    /// Task forwarding `discovery.events()` to the frontend as
    /// `device-discovered` / `device-disappeared`. `None` between
    /// `device_scan_start` and `device_scan_stop` calls.
    forwarder: Option<JoinHandle<()>>,
    /// Heartbeat task that re-emits the current device snapshot every
    /// 500 ms so the frontend's `lastSeenAt` prune logic sees a steady
    /// stream of updates for still-present devices.
    heartbeat: Option<JoinHandle<()>>,
}

static STATE: Lazy<Arc<Mutex<DiscoveryState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(DiscoveryState {
        discovery: None,
        forwarder: None,
        heartbeat: None,
    }))
});

/// Lazily start (or return) the process-wide `Discovery`. Called by both
/// the device-scan command and the WiFi-prov / SMP open paths so they all
/// share one set of scanners and one BLE peripheral store.
pub async fn discovery_handle() -> Result<Discovery, String> {
    let mut state = STATE.lock().await;
    if let Some(d) = &state.discovery {
        return Ok(d.clone());
    }
    let d = Discovery::start()
        .await
        .map_err(|e| format!("framelink::Discovery::start failed: {e}"))?;
    state.discovery = Some(d.clone());
    tlog!("[device_scan] framelink::Discovery started");
    Ok(d)
}

// ============================================================================
// Mapping framelink::Device → UnifiedDevice
// ============================================================================

fn capability_strs(device: &Device) -> Vec<String> {
    let transports = device.transports();
    let mut caps: Vec<&'static str> = device
        .capabilities()
        .iter()
        .filter_map(|c| match c {
            Capability::WifiProv => Some("wifi-provision"),
            Capability::Smp => Some("smp"),
            Capability::FrameLinkBle => Some("framelink"),
            _ => None,
        })
        .collect();

    // mDNS-only devices don't carry the WifiProv / FrameLinkBle bits in the
    // capability bitfield — the bitfield is BLE-mfg-data territory. But
    // reaching us via mDNS implies the device is provisioned, and
    // `_framelink._tcp` is itself the FrameLink-over-TCP announcement.
    // Synthesise both so the UI can route to the right flow.
    let is_mdns =
        transports.contains(&Transport::Tcp) || transports.contains(&Transport::Udp);
    if is_mdns && !caps.contains(&"wifi-provision") {
        caps.push("wifi-provision");
    }
    if transports.contains(&Transport::Tcp) && !caps.contains(&"framelink") {
        caps.push("framelink");
    }
    caps.into_iter().map(String::from).collect()
}

fn to_unified(device: &Device) -> UnifiedDevice {
    let id = device.id().as_str().to_string();
    let transport = device
        .transports()
        .first()
        .map(|t| t.to_string())
        .unwrap_or_else(|| "ble".to_string());
    let address_port = device.address().map(|sa| (sa.ip().to_string(), sa.port()));

    UnifiedDevice {
        name: device.name().to_string(),
        ble_id: id.strip_prefix("ble:").map(|s| s.to_string()),
        id,
        transport,
        rssi: device.rssi(),
        address: address_port.as_ref().map(|(a, _)| a.clone()),
        port: address_port.as_ref().map(|(_, p)| *p),
        capabilities: capability_strs(device),
    }
}

/// Normalise a wire-form id (legacy unprefixed btleplug id, full
/// `"ble:..."`, or `"mdns:..."`) into a [`DeviceId`] the live Discovery
/// will recognise. Shared by `ble_provision` and `smp_upgrade` so the
/// frontend can pass either form on connect.
pub fn canonical_device_id(device_id: String) -> DeviceId {
    if device_id.starts_with("ble:") || device_id.starts_with("mdns:") {
        DeviceId::new(device_id)
    } else {
        DeviceId::new(format!("ble:{device_id}"))
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Start emitting `device-discovered` events from the live framelink
/// Discovery. Idempotent — repeat calls do nothing while a forwarder is
/// already running.
#[tauri::command]
pub async fn device_scan_start(app: AppHandle) -> Result<(), String> {
    let discovery = discovery_handle().await?;

    let mut state = STATE.lock().await;
    if state.forwarder.is_some() {
        return Ok(());
    }

    // Re-emit anything the scanners have already seen so the UI has a
    // populated list immediately rather than waiting for the next
    // advertisement cycle.
    for device in discovery.devices().await {
        let _ = app.emit("device-discovered", to_unified(&device));
    }

    let app_for_events = app.clone();
    let discovery_for_events = discovery.clone();
    state.forwarder = Some(tokio::spawn(async move {
        let mut events = discovery_for_events.events();
        while let Some(event) = events.next().await {
            match event {
                DiscoveryEvent::Seen { device } => {
                    let _ = app_for_events.emit("device-discovered", to_unified(&device));
                }
                DiscoveryEvent::Updated { id, .. } => {
                    if let Some(device) = discovery_for_events.get(&id).await {
                        let _ = app_for_events.emit("device-discovered", to_unified(&device));
                    }
                }
                DiscoveryEvent::Lost { id } => {
                    let _ = app_for_events.emit("device-disappeared", id.as_str().to_string());
                }
                DiscoveryEvent::Error { source, message } => {
                    tlog!("[device_scan] Discovery error ({:?}): {}", source, message);
                }
            }
        }
        tlog!("[device_scan] event stream ended");
    }));

    let app_for_heartbeat = app.clone();
    let discovery_for_heartbeat = discovery;
    state.heartbeat = Some(tokio::spawn(async move {
        // 2s cadence — Discovery's own event stream pushes Seen / Updated
        // / Lost as they happen, so the heartbeat only exists to keep the
        // frontend's lastSeenAt prune from culling devices that are
        // present but quiet (no advertisement updates this cycle).
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
        tick.tick().await; // first tick fires immediately — already emitted the snapshot
        loop {
            tick.tick().await;
            for device in discovery_for_heartbeat.devices().await {
                let _ = app_for_heartbeat.emit("device-discovered", to_unified(&device));
            }
        }
    }));

    tlog!("[device_scan] forwarding Discovery events to frontend");
    Ok(())
}

/// Stop forwarding Discovery events. The underlying scanners stay alive
/// (no API to pause them) so re-starting is instant; the frontend just
/// stops receiving heartbeats.
#[tauri::command]
pub async fn device_scan_stop(_app: AppHandle) -> Result<(), String> {
    let mut state = STATE.lock().await;
    if let Some(handle) = state.forwarder.take() {
        handle.abort();
    }
    if let Some(handle) = state.heartbeat.take() {
        handle.abort();
    }
    tlog!("[device_scan] forwarding stopped");
    Ok(())
}


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
    /// Heartbeat task that re-emits the current device snapshot so the
    /// frontend's `lastSeenAt` prune logic sees a steady stream of
    /// updates for still-present devices.
    heartbeat: Option<JoinHandle<()>>,
    /// One-shot timer that emits `device-scan-finished` once the initial
    /// scan window has settled. The frontend uses this to flip
    /// `isScanning` off and re-enable the Rescan button — events keep
    /// flowing afterwards, this is purely a UI signal.
    settled_signal: Option<JoinHandle<()>>,
}

/// How long after `device_scan_start` to emit `device-scan-finished`.
/// Long enough for the BLE poll cadence (500 ms inside framelink) to
/// have surfaced any device in advertising range plus the mDNS resolver
/// to have answered, short enough that the user sees the Rescan button
/// light up well before they grow impatient.
const SCAN_SETTLE_AFTER: std::time::Duration = std::time::Duration::from_secs(8);

static STATE: Lazy<Arc<Mutex<DiscoveryState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(DiscoveryState {
        discovery: None,
        forwarder: None,
        heartbeat: None,
        settled_signal: None,
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

/// Resolves a UI-facing device selection string to the live [`DeviceId`]
/// held by Discovery.
///
/// The frontend passes either a real framelink id (`ble:<uuid>`,
/// `mdns:udp:<instance>`) or a `"{transport}:{name}"` selection string
/// (e.g. `"ble:WiredFlexLink-9C1C"`). This function:
///
/// 1. Tries the input as a canonical id — if Discovery has a live entry,
///    returns it immediately.
/// 2. Strips the known UI-selection prefixes to extract the device name,
///    then finds the matching device filtered by `transport` (prevents
///    picking the wrong-transport twin when a device advertises on both
///    BLE and UDP).
/// 3. Returns an error if nothing matches — the caller gets a clear
///    diagnostic rather than a silent wrong-id failure downstream.
pub async fn resolve_device_id(
    raw: &str,
    transport: Transport,
) -> Result<DeviceId, String> {
    let discovery = discovery_handle().await?;

    // 1. Try the input as a real framelink id first.
    let canonical = canonical_device_id(raw.to_string());
    if discovery.get(&canonical).await.is_some() {
        return Ok(canonical);
    }

    // 2. Strip known UI-selection prefixes to get the device name.
    let name = raw
        .strip_prefix("mdns:udp:")
        .or_else(|| raw.strip_prefix("mdns:"))
        .or_else(|| raw.strip_prefix("ble:"))
        .or_else(|| raw.strip_prefix("udp:"))
        .or_else(|| raw.strip_prefix("ip:"))
        .or_else(|| raw.strip_prefix("fl:"))
        .unwrap_or(raw);

    // 3. Match by name + transport so a dual-transport device resolves to
    //    the correct entry.
    if let Some(device) = discovery
        .devices()
        .await
        .into_iter()
        .find(|d| d.name() == name && d.transports().contains(&transport))
    {
        return Ok(device.id().clone());
    }

    Err(format!(
        "device '{name}' not in discovery for transport {transport:?} (input was '{raw}')"
    ))
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

    // Re-emit anything the scanners have already seen so the UI has a
    // populated list immediately rather than waiting for the next
    // advertisement cycle.
    for device in discovery.devices().await {
        let _ = app.emit("device-discovered", to_unified(&device));
    }

    // Forwarder is started once and never stopped — it carries
    // `device-disconnected` events from framelink's lease watcher.
    if state.forwarder.is_none() {
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
        tlog!("[device_scan] forwarder started");
    }

    if state.heartbeat.is_some() {
        // Already scanning — nothing more to do.
        return Ok(());
    }

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

    let app_for_settled = app;
    state.settled_signal = Some(tokio::spawn(async move {
        tokio::time::sleep(SCAN_SETTLE_AFTER).await;
        let _ = app_for_settled.emit("device-scan-finished", ());
    }));

    tlog!("[device_scan] heartbeat started");
    Ok(())
}

/// Stop the periodic heartbeat that re-emits the device-discovered
/// snapshot for the scan view. The Discovery event forwarder itself
/// stays alive — `Lost` events from mDNS/BLE eviction must continue
/// reaching the frontend after the user has navigated to a connected-
/// device page.
#[tauri::command]
pub async fn device_scan_stop(_app: AppHandle) -> Result<(), String> {
    let mut state = STATE.lock().await;
    if let Some(handle) = state.heartbeat.take() {
        handle.abort();
    }
    if let Some(handle) = state.settled_signal.take() {
        handle.abort();
    }
    tlog!("[device_scan] heartbeat stopped (forwarder remains)");
    Ok(())
}

/// Single point of tear-down for a device. Drops every cached
/// `Arc<Session>` framelink-rs is holding for the id; once any
/// in-flight operation drops its local clone, the lease's strong
/// count falls to zero and `PeripheralLease::Drop` runs the BLE
/// disconnect. UDP id (`mdns:udp:...`) is supported here too — the
/// release just clears the cache entry, no link-layer disconnect
/// needed.
#[tauri::command]
pub async fn release_device(device_id: String) -> Result<(), String> {
    let id = canonical_device_id(device_id);
    let discovery = discovery_handle().await?;
    discovery.release_device(&id).await;
    tlog!("[device_scan] released device {}", id);
    Ok(())
}


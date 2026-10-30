use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use crate::capture_store;
use crate::io::session_log::{self, SessionLogEvent, Subject};
use crate::io::{probe_gvret_tcp, GvretDeviceInfo};
#[cfg(not(target_os = "ios"))]
use crate::io::probe_gvret_usb;
use crate::settings::{AppSettings, IOProfile};

/// Result of probing any real-time device.
/// Provides a unified structure for all device types.
#[derive(Clone, Debug, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DeviceProbeResult {
    /// Whether the probe was successful (device is online and responding)
    pub success: bool,
    /// Device type (e.g., "gvret", "slcan", "gs_usb", "socketcan")
    pub source_type: String,
    /// Whether this is a multi-bus device (GVRET can have multiple CAN buses)
    pub is_multi_bus: bool,
    /// Number of buses available (1 for single-bus devices, 1-5 for GVRET)
    pub bus_count: u8,
    /// Primary info line (firmware version, device name, etc.)
    pub primary_info: Option<String>,
    /// Secondary info line (hardware version, channel count, etc.)
    pub secondary_info: Option<String>,
    /// Whether device supports CAN FD (gs_usb devices only, None for others)
    pub supports_fd: Option<bool>,
    /// Error message if probe failed
    pub error: Option<String>,
}

impl DeviceProbeResult {
    fn failure(source_type: &str, is_multi_bus: bool, error: impl Into<String>) -> Self {
        Self {
            success: false,
            source_type: source_type.to_string(),
            is_multi_bus,
            bus_count: 0,
            primary_info: None,
            secondary_info: None,
            supports_fd: None,
            error: Some(error.into()),
        }
    }
}

/// The last successful probe of each profile, answered while a session holds the
/// device, which often cannot be opened a second time.
static PROBE_CACHE: Lazy<Mutex<HashMap<String, DeviceProbeResult>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_probe_result(profile_id: &str, result: &DeviceProbeResult) {
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        if result.success {
            cache.insert(profile_id.to_string(), result.clone());
        } else {
            cache.remove(profile_id);
        }
    }
}

/// Get a cached probe result for a profile
pub(crate) fn get_cached_probe(profile_id: &str) -> Option<DeviceProbeResult> {
    PROBE_CACHE.lock().ok()?.get(profile_id).cloned()
}

/// Forget a profile's probe, once its device has been edited, replaced or removed.
pub fn clear_probe_cache(profile_id: &str) {
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        cache.remove(profile_id);
    }
}

fn log_probe(profile_id: &str, result: &DeviceProbeResult, cached: bool) {
    session_log::append(
        Subject { profile_ids: Some(vec![profile_id.to_string()]), ..Subject::default() },
        SessionLogEvent::DeviceProbe {
            source_type: result.source_type.clone(),
            address: result.secondary_info.clone().unwrap_or_default(),
            success: result.success,
            cached,
            bus_count: result.bus_count,
            error: result.error.clone(),
        },
    );
}

/// Probe a capture or a saved profile. A profile a session holds is answered from
/// the cache if it has an entry, without awaiting `settings`.
pub async fn probe_device(
    profile_id: &str,
    settings: impl Future<Output = Result<AppSettings, String>>,
) -> Result<DeviceProbeResult, String> {
    // Capture IDs — metadata already in memory, no profile lookup needed
    if capture_store::is_known_capture(profile_id) {
        if let Some(meta) = capture_store::get_capture_metadata(profile_id) {
            let bus_count = if meta.buses.is_empty() { 1 } else { meta.buses.len() as u8 };
            let is_multi_bus = meta.buses.len() > 1;
            let result = DeviceProbeResult {
                success: true,
                source_type: "capture".to_string(),
                is_multi_bus,
                bus_count,
                primary_info: Some(format!("{} buses", bus_count)),
                secondary_info: Some(meta.id.clone()),
                supports_fd: None,
                error: None,
            };
            log_probe(profile_id, &result, false);
            // Don't cache capture probes — metadata may change as data streams in
            return Ok(result);
        } else {
            return Err(format!("Capture '{}' not found", profile_id));
        }
    }

    if let Some(cached) = get_cached_probe(profile_id)
        .filter(|_| !crate::sessions::get_sessions_for_profile(profile_id).is_empty())
    {
        tlog!("[probe_device] Returning cached probe result for profile '{}'", profile_id);
        log_probe(profile_id, &cached, true);
        return Ok(cached);
    }

    probe_profile(settings.await?.profile(profile_id)?).await
}

/// Connect to a profile's device, query it and close again; a success is cached and a
/// failure clears the cache.
///
/// Supported device types:
/// - gvret_tcp, gvret_usb: Multi-bus GVRET devices
/// - slcan: Single-bus slcan/CANable devices
/// - gs_usb: Single-bus gs_usb/candleLight devices (Windows/macOS)
/// - socketcan: Single-bus SocketCAN interfaces (Linux)
/// - serial: Raw serial ports (always "online" if port exists)
pub async fn probe_profile(profile: &IOProfile) -> Result<DeviceProbeResult, String> {
    #[cfg(not(target_os = "ios"))]
    use crate::io::slcan::reader::probe_slcan;

    let result = match profile.kind.as_str() {
        // GVRET devices - multi-bus
        "gvret_tcp" | "gvret_usb" => {
            let GvretProbe { address, info } = probe_gvret(profile).await?;
            Ok(match info {
                Ok(info) => DeviceProbeResult {
                    success: true,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(address),
                    supports_fd: None,
                    error: None,
                },
                Err(e) => DeviceProbeResult::failure("gvret", true, e),
            })
        }

        // slcan devices - single-bus (desktop only)
        #[cfg(not(target_os = "ios"))]
        "slcan" => {
            let result = probe_slcan(&profile.req_str("port")?, profile.line_settings()?).await;

            Ok(DeviceProbeResult {
                success: result.success,
                source_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: if result.success { 1 } else { 0 },
                primary_info: result.version,
                secondary_info: result.hardware_version,
                supports_fd: result.supports_fd,
                error: result.error,
            })
        }
        #[cfg(target_os = "ios")]
        "slcan" => Ok(DeviceProbeResult::failure("slcan", false, "slcan is not available on iOS")),

        // gs_usb devices - single-bus (Windows/macOS via nusb)
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        "gs_usb" => {
            use crate::io::gs_usb::probe_gs_usb_device;

            let bus = profile.conn_i64("bus").unwrap_or_default() as u8;
            let address = profile.conn_i64("address").unwrap_or_default() as u8;
            // Serial number for stable device matching across USB re-enumeration
            let serial = profile.conn_str("serial");

            match probe_gs_usb_device(bus, address, serial).await {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "gs_usb".to_string(),
                    is_multi_bus: false,
                    bus_count: info.channel_count.unwrap_or(1) as u8,
                    primary_info: info.channel_count.map(|c| format!("{} channel(s)", c)),
                    secondary_info: if info.supports_fd.unwrap_or(false) {
                        Some("CAN FD supported".to_string())
                    } else {
                        None
                    },
                    supports_fd: info.supports_fd,
                    error: None,
                }),
                Err(e) => Ok(DeviceProbeResult::failure("gs_usb", false, e)),
            }
        }

        // SocketCAN - Linux only, check if interface exists
        #[cfg(target_os = "linux")]
        "socketcan" => {
            let interface = profile.conn_str("interface").unwrap_or_default();

            // Check if the interface exists by reading from /sys/class/net
            let path = format!("/sys/class/net/{}", interface);
            if std::path::Path::new(&path).exists() {
                Ok(DeviceProbeResult {
                    success: true,
                    source_type: "socketcan".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(format!("Interface: {}", interface)),
                    secondary_info: None,
                    supports_fd: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult::failure(
                    "socketcan",
                    false,
                    format!("Interface '{}' not found", interface),
                ))
            }
        }

        // Serial port - check if port exists (desktop only)
        #[cfg(not(target_os = "ios"))]
        "serial" => {
            let port = profile.req_str("port")?;

            let port_exists = wslib_serial::ports()
                .unwrap_or_default()
                .iter()
                .any(|p| p.path == port);

            if port_exists {
                Ok(DeviceProbeResult {
                    success: true,
                    source_type: "serial".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(port.clone()),
                    secondary_info: None,
                    supports_fd: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult::failure("serial", false, format!("Port '{}' not found", port)))
            }
        }
        #[cfg(target_os = "ios")]
        "serial" => Ok(DeviceProbeResult::failure("serial", false, "Serial ports are not available on iOS")),

        // Modbus TCP - probe by attempting a TCP connection
        "modbus_tcp" => {
            let host = profile.conn_str("host").unwrap_or_default();
            let port = profile.conn_i64("port").unwrap_or_default() as u16;
            let timeout_sec = profile.conn_f64("timeout").unwrap_or_default();

            let addr = format!("{}:{}", host, port);
            let failure = |error: String| DeviceProbeResult {
                secondary_info: Some(addr.clone()),
                ..DeviceProbeResult::failure("modbus_tcp", false, error)
            };

            // Resolve before connecting, like every other Modbus TCP path — passing
            // the "host:port" string to connect() resolves inside the timeout, which
            // reports a DNS failure as a connection one.
            let sock_addr = match crate::io::net::resolve_host_port(&host, port).await {
                Ok(a) => a,
                Err(e) => return Ok(failure(e.user_message())),
            };

            match tokio::time::timeout(
                std::time::Duration::from_secs_f64(timeout_sec),
                tokio::net::TcpStream::connect(sock_addr),
            ).await {
                Ok(Ok(_stream)) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "modbus_tcp".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some("Modbus TCP".to_string()),
                    secondary_info: Some(addr),
                    supports_fd: None,
                    error: None,
                }),
                Ok(Err(e)) => Ok(failure(format!("Connection failed: {}", e))),
                Err(_) => Ok(failure(format!("Connection timed out after {}s", timeout_sec))),
            }
        }

        // FrameLink device — grouped profile with interfaces[], TCP probe to verify reachability
        "framelink" => {
            let host = profile.req_str("host")?;
            let port = profile.conn_i64("port").unwrap_or_default() as u16;
            // `as_f64()` only, before — and the form writes strings, so a
            // configured timeout was silently ignored.
            let timeout_sec = profile.conn_f64("timeout").unwrap_or_default();
            let device_id = profile.conn_str("device_id");
            let iface_count = profile.connection.get("interfaces")
                .and_then(|v| v.as_list())
                .map(|a| a.len() as u8)
                .unwrap_or(1);

            match crate::io::framelink::probe_framelink(&host, port, timeout_sec).await {
                Ok(probe) => {
                    let bus_count = probe.interfaces.len().max(iface_count as usize) as u8;
                    Ok(DeviceProbeResult {
                        success: true,
                        source_type: "framelink".to_string(),
                        is_multi_bus: bus_count > 1,
                        bus_count,
                        primary_info: device_id.map(|s| s.to_string()),
                        secondary_info: Some(format!("{}:{}", host, port)),
                        supports_fd: None,
                        error: None,
                    })
                }
                Err(e) => Ok(DeviceProbeResult {
                    is_multi_bus: iface_count > 1,
                    bus_count: iface_count,
                    primary_info: device_id.map(|s| s.to_string()),
                    ..DeviceProbeResult::failure("framelink", false, e.to_string())
                }),
            }
        }

        // Virtual adapter — always succeeds, reports configured interface count and traffic type
        "virtual" => {
            let bus_count = profile
                .connection
                .get("interfaces")
                .and_then(|v| v.as_list())
                .map(|a| a.len() as u8)
                .unwrap_or_else(|| profile.conn_i64("bus_count").unwrap_or_default().clamp(1, 8) as u8);
            let traffic_type = profile.conn_str("traffic_type").unwrap_or_default();
            let traffic_label = match traffic_type.as_str() {
                "canfd" => "CAN-FD",
                "modbus" => "Modbus",
                "serial" => "Serial",
                _ => "CAN",
            };
            let supports_fd = traffic_type == "canfd";
            Ok(DeviceProbeResult {
                success: true,
                source_type: "virtual".to_string(),
                is_multi_bus: bus_count > 1,
                bus_count,
                primary_info: Some(format!("{}", traffic_label)),
                secondary_info: Some(format!("{} interface(s)", bus_count)),
                supports_fd: Some(supports_fd),
                error: None,
            })
        }

        // Recorded sources or unsupported types
        _ => Err(format!(
            "Profile '{}' is not a real-time device (kind: {})",
            profile.id, profile.kind
        )),
    };

    // Emit probe result event (fresh probe, not cached)
    if let Ok(ref probe_result) = result {
        log_probe(&profile.id, probe_result, false);
        cache_probe_result(&profile.id, probe_result);
    }

    result
}

/// A GVRET's bus count, never cached. `settings` is always awaited.
pub async fn probe_gvret_device(
    profile_id: &str,
    settings: impl Future<Output = Result<AppSettings, String>>,
) -> Result<GvretDeviceInfo, String> {
    probe_gvret(settings.await?.profile(profile_id)?).await?.info
}

/// The outcome of asking a GVRET for its buses, and the address it was asked at.
struct GvretProbe {
    address: String,
    info: Result<GvretDeviceInfo, String>,
}

/// An `Err` is a profile that cannot be probed as a GVRET at all.
async fn probe_gvret(profile: &IOProfile) -> Result<GvretProbe, String> {
    match profile.kind.as_str() {
        "gvret_tcp" => {
            let host = profile.conn_str("host").unwrap_or_default();
            let port = profile.conn_i64("port").unwrap_or_default() as u16;
            let timeout_sec = profile.conn_f64("timeout").unwrap_or_default();
            let info = probe_gvret_tcp(&host, port, timeout_sec).await;
            Ok(GvretProbe { address: format!("{}:{}", host, port), info })
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            let port = profile.req_str("port")?;
            let info = probe_gvret_usb(&port, profile.line_settings()?).await;
            Ok(GvretProbe { address: port, info })
        }
        #[cfg(target_os = "ios")]
        "gvret_usb" => Ok(GvretProbe {
            address: String::new(),
            info: Err("GVRET USB is not available on iOS".to_string()),
        }),
        _ => Err(format!(
            "Profile '{}' is not a GVRET device (kind: {})",
            profile.id, profile.kind
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::net::TcpListener;

    fn profile(id: &str, kind: &str, connection: Value) -> IOProfile {
        IOProfile {
            id: id.into(),
            kind: kind.into(),
            connection: serde_json::from_value(connection).expect("an object"),
            ..Default::default()
        }
    }

    fn tcp(id: &str, kind: &str, port: u16) -> IOProfile {
        profile(id, kind, json!({ "host": "127.0.0.1", "port": port, "timeout": 2.0 }))
    }

    async fn settings_with(profile: IOProfile) -> Result<AppSettings, String> {
        Ok(AppSettings { io_profiles: vec![profile], ..Default::default() })
    }

    async fn never_read() -> Result<AppSettings, String> {
        panic!("the settings were read")
    }

    async fn unreadable() -> Result<AppSettings, String> {
        Err("unreadable".into())
    }

    async fn closed_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        listener.local_addr().expect("addr").port()
    }

    fn probe(success: bool) -> DeviceProbeResult {
        DeviceProbeResult {
            success,
            source_type: "gvret".into(),
            is_multi_bus: true,
            bus_count: 2,
            primary_info: None,
            secondary_info: None,
            supports_fd: None,
            error: (!success).then(|| "offline".into()),
        }
    }

    #[test]
    fn only_the_latest_probe_is_cached_and_only_a_success() {
        cache_probe_result("p_failed", &probe(false));
        assert!(get_cached_probe("p_failed").is_none());

        cache_probe_result("p_ok", &probe(true));
        assert_eq!(get_cached_probe("p_ok").map(|r| r.bus_count), Some(2));

        cache_probe_result("p_ok", &probe(false));
        assert!(get_cached_probe("p_ok").is_none(), "a later failure clears the success");

        cache_probe_result("p_ok", &probe(true));
        clear_probe_cache("p_ok");
        assert!(get_cached_probe("p_ok").is_none());
    }

    #[tokio::test]
    async fn a_gvret_reports_its_buses_at_its_address() {
        let (port, _commands) = crate::io::gvret::fake_gvret(0, false).await;
        let gvret = tcp("probe-gvret", "gvret_tcp", port);

        let result = probe_profile(&gvret).await;
        clear_probe_cache("probe-gvret");
        let result = result.expect("probed");
        assert!(result.success && result.is_multi_bus);
        assert_eq!(result.bus_count, 2);
        assert_eq!(result.primary_info.as_deref(), Some("2 buses available"));
        assert_eq!(result.secondary_info, Some(format!("127.0.0.1:{port}")));

        let info = probe_gvret_device("probe-gvret", settings_with(gvret)).await.expect("probed");
        assert_eq!(info.bus_count, 2);
        assert!(get_cached_probe("probe-gvret").is_none(), "the GVRET-only probe caches nothing");
    }

    #[tokio::test]
    async fn a_gvret_that_refuses_is_a_failed_probe_but_a_gvret_probe_error() {
        let gvret = tcp("probe-gvret-refused", "gvret_tcp", closed_port().await);

        let result = probe_profile(&gvret).await.expect("a result");
        assert!(!result.success && result.is_multi_bus);
        assert_eq!((result.bus_count, result.secondary_info), (0, None));
        assert!(result.error.as_deref().is_some_and(|e| e.contains("127.0.0.1")), "{:?}", result.error);

        assert!(probe_gvret_device("probe-gvret-refused", settings_with(gvret)).await.is_err());
    }

    #[tokio::test]
    async fn only_a_gvret_profile_has_a_gvret_probe() {
        let virtual_device = profile("probe-not-gvret", "virtual", json!({}));
        assert_eq!(
            probe_gvret_device("probe-not-gvret", settings_with(virtual_device)).await.unwrap_err(),
            "Profile 'probe-not-gvret' is not a GVRET device (kind: virtual)"
        );
    }

    #[tokio::test]
    async fn a_modbus_device_that_accepts_a_connection_is_online() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();

        let result = probe_profile(&tcp("probe-modbus", "modbus_tcp", port)).await;
        clear_probe_cache("probe-modbus");
        let result = result.expect("probed");
        assert!(result.success && !result.is_multi_bus);
        assert_eq!(result.bus_count, 1);
        assert_eq!(result.primary_info.as_deref(), Some("Modbus TCP"));
        assert_eq!(result.secondary_info, Some(format!("127.0.0.1:{port}")));
    }

    #[tokio::test]
    async fn a_refused_modbus_connection_still_names_the_address() {
        let port = closed_port().await;
        let result = probe_profile(&tcp("probe-modbus-refused", "modbus_tcp", port)).await.expect("a result");
        assert!(!result.success);
        assert_eq!(result.bus_count, 0);
        assert_eq!(result.secondary_info, Some(format!("127.0.0.1:{port}")));
        assert!(result.error.as_deref().is_some_and(|e| e.starts_with("Connection failed:")), "{:?}", result.error);
    }

    #[tokio::test]
    async fn a_virtual_device_reports_its_buses_and_traffic() {
        let counted = profile("probe-virtual-fd", "virtual", json!({ "bus_count": 3, "traffic_type": "canfd" }));
        let listed = profile("probe-virtual-can", "virtual", json!({ "interfaces": [{}, {}], "bus_count": 5 }));

        let fd = probe_profile(&counted).await.expect("probed");
        let can = probe_profile(&listed).await.expect("probed");
        clear_probe_cache("probe-virtual-fd");
        clear_probe_cache("probe-virtual-can");

        assert!(fd.success && fd.is_multi_bus);
        assert_eq!((fd.bus_count, fd.supports_fd), (3, Some(true)));
        assert_eq!(fd.primary_info.as_deref(), Some("CAN-FD"));
        assert_eq!(fd.secondary_info.as_deref(), Some("3 interface(s)"));
        assert_eq!((can.bus_count, can.supports_fd), (2, Some(false)), "the interface list beats bus_count");
        assert_eq!(can.primary_info.as_deref(), Some("CAN"));
    }

    #[tokio::test]
    async fn a_recorded_kind_is_not_probed() {
        assert_eq!(
            probe_profile(&profile("probe-csv", "csv", json!({}))).await.unwrap_err(),
            "Profile 'probe-csv' is not a real-time device (kind: csv)"
        );
    }

    #[tokio::test]
    async fn a_capture_is_answered_from_its_metadata_without_reading_the_settings() {
        use crate::capture_store::{create_standalone_capture, CaptureKind};
        crate::capture_db::use_in_memory_database();
        let id = create_standalone_capture(CaptureKind::Frames, "probed".into());

        let result = probe_device(&id, never_read()).await.expect("probed");
        assert_eq!(result.source_type, "capture");
        assert!(result.success && !result.is_multi_bus);
        assert_eq!(result.bus_count, 1);
        assert_eq!(result.primary_info.as_deref(), Some("1 buses"));
        assert_eq!(result.secondary_info, Some(id.clone()));
        assert!(get_cached_probe(&id).is_none(), "a capture's probe is not cached");
    }

    #[tokio::test]
    async fn a_held_profile_is_answered_from_the_cache_without_reading_the_settings() {
        let virtual_device = profile("probe-held", "virtual", json!({ "bus_count": 2 }));
        let fresh = probe_device("probe-held", settings_with(virtual_device)).await.expect("probed");

        crate::sessions::register_session_profile("f_probe_held", "probe-held");
        let cached = probe_device("probe-held", never_read()).await;
        crate::sessions::release_session_profiles("f_probe_held");
        clear_probe_cache("probe-held");
        assert_eq!(cached.expect("cached").bus_count, fresh.bus_count);
    }

    #[tokio::test]
    async fn an_idle_profile_is_probed_again_and_a_failure_clears_its_entry() {
        cache_probe_result("probe-idle", &probe(true));
        let gone = tcp("probe-idle", "modbus_tcp", closed_port().await);

        let result = probe_device("probe-idle", settings_with(gone)).await.expect("a result");
        assert!(!result.success, "an idle profile's cached success was answered");
        assert!(get_cached_probe("probe-idle").is_none());
    }

    #[tokio::test]
    async fn a_failed_probe_is_not_cached() {
        let modbus = tcp("probe-uncached", "modbus_tcp", closed_port().await);
        assert!(!probe_device("probe-uncached", settings_with(modbus)).await.expect("a result").success);
        assert_eq!(probe_device("probe-uncached", unreadable()).await.unwrap_err(), "unreadable");
    }

    #[tokio::test]
    async fn an_unknown_profile_is_named() {
        let other = profile("probe-other", "virtual", json!({}));
        assert_eq!(
            probe_device("probe-nobody", settings_with(other)).await.unwrap_err(),
            "Profile 'probe-nobody' not found"
        );
    }
}

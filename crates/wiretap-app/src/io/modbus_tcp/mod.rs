// io/modbus_tcp/mod.rs
//
// Modbus TCP client driver for polling registers and scanning Modbus devices.
// - Source: catalog-driven polling of known registers
// - Scanner: one-shot discovery of registers and active unit IDs

mod conn;
pub mod poll;
pub mod ranges;
mod reader;
pub mod scan_source;
pub mod scanner;

pub use ranges::{build_polls_from_ranges, ModbusRange, ModbusRangeSpec};
pub use scan_source::{ModbusScanSource, ScanJob};
pub use reader::{ModbusTcpConfig, ModbusTcpSource, PollEmitMode, PollGroup, RegisterType};
pub use scanner::{
    FcProbeConfig, FcProbeEntry, ModbusScanConfig, ScanCompletePayload, UnitIdScanConfig,
};

/// Read `host`/`port`/`unit_id` off a Modbus profile's connection map.
///
/// The values come from `io::device_kinds`, which is also what the form seeds
/// from — this function used to carry its own `127.0.0.1`/502/1 while the form
/// pre-filled `192.168.1.100`, so a profile with a blank host was dialled
/// somewhere the user had never been shown.
pub fn modbus_endpoint(profile: &crate::settings::IOProfile) -> (String, u16, u8) {
    use crate::io::device_kinds::{conn_i64, conn_str};
    (
        conn_str(profile, "host").unwrap_or_default(),
        conn_i64(profile, "port").unwrap_or_default() as u16,
        conn_i64(profile, "unit_id").unwrap_or_default() as u8,
    )
}

/// A Modbus profile's `host:port`, spelled the one way.
///
/// The contention guards — `scan_holding`, `endpoint_in_use_by_poller` and the
/// resume check — compare these strings against each other and against
/// `ScanJob::endpoint()`, so the spelling has to come from one place or the
/// guards silently stop matching.
pub fn modbus_endpoint_str(profile: &crate::settings::IOProfile) -> String {
    let (host, port, _) = modbus_endpoint(profile);
    format!("{host}:{port}")
}

/// The session's first *Modbus* source profile — not simply its first, since a
/// multi-source session may list a CAN source ahead of the Modbus one.
///
/// Takes already-loaded settings so a caller checking several sessions reads the
/// settings file once.
///
/// Call this **before** stopping the session. Stopping swaps a session's profile
/// ids for its capture id (`replace_session_profiles` in `stop_and_switch_to_capture`),
/// so a stopped session resolves to a capture and no longer names its device.
pub fn session_modbus_profile<'a>(
    settings: &'a crate::settings::AppSettings,
    session_id: &str,
) -> Option<&'a crate::settings::IOProfile> {
    crate::sessions::get_session_profile_ids(session_id)
        .iter()
        .find_map(|id| {
            settings
                .io_profiles
                .iter()
                .find(|p| &p.id == id && p.kind == "modbus_tcp")
        })
}

/// Resolve the Modbus device behind a session, for tools that scan "whatever this
/// session is talking to" rather than an address the user typed.
pub fn session_modbus_endpoint(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(String, u16, u8), String> {
    let settings = crate::settings::load_settings_sync(app)?;
    session_modbus_profile(&settings, session_id)
        .map(modbus_endpoint)
        .ok_or_else(|| format!("Session '{session_id}' has no Modbus source profile"))
}

/// Map the catalogue crate's register type onto the IO layer's enum.
fn map_register_type(rt: wiretap_catalog::modbus::RegisterType) -> RegisterType {
    use wiretap_catalog::modbus::RegisterType as Cat;
    match rt {
        Cat::Input => RegisterType::Input,
        Cat::Holding => RegisterType::Holding,
        Cat::Coil => RegisterType::Coil,
        Cat::Discrete => RegisterType::Discrete,
    }
}

/// Build Modbus poll groups from a catalogue's `[frame.modbus.*]` entries via the
/// shared `wiretap-catalog` crate (which resolves the register-from-key and
/// signal-less-register shorthands, the `register_base` protocol address, the
/// per-register slave address, and the poll interval). The single source of truth
/// for catalogue → polls, shared by the interactive editor (`catalog.polls` WS
/// command) and the MCP/headless open flow. A catalogue with no Modbus frames
/// yields no polls (not an error).
///
/// Frames marked `disabled` are skipped — the catalogue crate defines that flag
/// as "the poll task skips this frame entirely", which WireTAP previously ignored.
pub fn build_polls_from_catalog(catalog_toml: &str) -> Result<Vec<PollGroup>, String> {
    use wiretap_catalog::modbus::{ManifestError, ModbusManifest};
    let manifest = match ModbusManifest::parse(catalog_toml) {
        Ok(m) => m,
        Err(ManifestError::NoFrames) => return Ok(vec![]),
        Err(e) => return Err(format!("Failed to parse catalog: {e}")),
    };
    Ok(manifest
        .frames
        .iter()
        .filter(|f| !f.disabled)
        .map(|f| PollGroup {
            register_type: map_register_type(f.register_type),
            start_register: manifest.protocol_address(f),
            count: f.length,
            interval_ms: f.interval_ms,
            frame_id: f.register_number as u32,
            device_address: f.device_address,
            // Catalogue signals are bit offsets into the whole block.
            emit_mode: PollEmitMode::Block,
        })
        .collect())
}

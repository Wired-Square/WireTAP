// io/modbus_tcp/mod.rs
//
// Modbus TCP client driver for polling registers and scanning Modbus devices.
// - Source: catalog-driven polling of known registers
// - Scanner: one-shot discovery of registers and active unit IDs

mod reader;
pub mod scanner;

pub use reader::{ModbusTcpConfig, ModbusTcpSource, PollGroup, RegisterType};
pub use scanner::{
    ModbusScanConfig, ScanCompletePayload, UnitIdScanConfig,
};

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
        .map(|f| PollGroup {
            register_type: map_register_type(f.register_type),
            start_register: manifest.protocol_address(f),
            count: f.length,
            interval_ms: f.interval_ms,
            frame_id: f.register_number as u32,
            device_address: f.device_address,
        })
        .collect())
}

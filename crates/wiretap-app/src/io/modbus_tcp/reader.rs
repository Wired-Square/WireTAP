// io/modbus_tcp/reader.rs
//
// Modbus TCP poll groups: one register read on a timer each.
//   - Each poll response becomes a FrameMessage with protocol="modbus"
//   - frame_id = register_number from the catalog
//   - bytes = raw register data (big-endian, 2 bytes per register)
//
// Catalog-driven: the frontend extracts poll groups from [frame.modbus.*]
// catalog entries and passes them as JSON when creating the session.

use serde::Deserialize;
use std::str::FromStr;
use std::time::Duration;
use wiretap_catalog::modbus::PollItem;

// ============================================================================
// Configuration
// ============================================================================

/// Register type for Modbus polling
#[derive(Clone, Debug, serde::Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "ModbusRegisterType"))]
pub enum RegisterType {
    Holding,
    Input,
    Coil,
    Discrete,
}

impl RegisterType {
    /// The catalogue library's equivalent, which owns the protocol facts —
    /// read/write caps, the function-code mapping, coil packing.
    ///
    /// The two enums stay separate because this one is the serde shape of an
    /// IO profile and the MCP API, and the catalogue's is part of a published
    /// crate. The numbers behind them should not be duplicated as well, so
    /// everything that needs a Modbus fact crosses over here to ask for it.
    pub fn catalog(&self) -> wiretap_catalog::RegisterType {
        match self {
            RegisterType::Holding => wiretap_catalog::RegisterType::Holding,
            RegisterType::Input => wiretap_catalog::RegisterType::Input,
            RegisterType::Coil => wiretap_catalog::RegisterType::Coil,
            RegisterType::Discrete => wiretap_catalog::RegisterType::Discrete,
        }
    }
}

impl From<wiretap_catalog::RegisterType> for RegisterType {
    fn from(rt: wiretap_catalog::RegisterType) -> Self {
        use wiretap_catalog::RegisterType as Cat;
        match rt {
            Cat::Input => RegisterType::Input,
            Cat::Holding => RegisterType::Holding,
            Cat::Coil => RegisterType::Coil,
            Cat::Discrete => RegisterType::Discrete,
        }
    }
}

impl FromStr for RegisterType {
    type Err = wiretap_catalog::UnknownRegisterType;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<wiretap_catalog::RegisterType>().map(Self::from)
    }
}

/// How a poll response becomes frames.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum PollEmitMode {
    /// One frame per group, bytes = the whole block. Required for catalogue
    /// polls: their signals are bit offsets into the entire block.
    #[default]
    Block,
    /// One frame per register, frame_id = the register address. Used by
    /// discovery sweeps so per-register change analysis works.
    PerRegister,
}

/// A single poll group - one register read operation on a timer
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
pub struct PollGroup {
    /// Register type (determines Modbus function code)
    pub register_type: RegisterType,
    /// Protocol-level start address (0-based, 0-65535)
    pub start_register: u16,
    /// Number of registers (or coils) to read
    pub count: u16,
    /// Poll interval in milliseconds
    pub interval_ms: u64,
    /// frame_id to emit (= catalog register_number)
    pub frame_id: u32,
    /// Device (slave) address to poll — resolved from the register's node.
    /// Defaults to 1 so older poll payloads without this field still load.
    #[serde(default = "default_device_address")]
    pub device_address: u8,
    /// Defaults to `Block` so catalogue-derived poll payloads — including any
    /// already persisted without this field — keep their existing shape.
    #[serde(default)]
    pub emit_mode: PollEmitMode,
}

fn default_device_address() -> u8 {
    1
}

impl PollGroup {
    pub(super) fn from_item<T>(item: PollItem<T>, frame_id: u32, emit_mode: PollEmitMode) -> Self {
        Self {
            register_type: item.register_type.into(),
            start_register: item.start,
            count: item.count,
            interval_ms: item.interval.as_millis() as u64,
            frame_id,
            device_address: item.device_address,
            emit_mode,
        }
    }

    /// A zero interval would poll flat out.
    pub(super) fn to_item(&self) -> PollItem<PollGroup> {
        PollItem {
            register_type: self.register_type.catalog(),
            start: self.start_register,
            count: self.count,
            interval: Duration::from_millis(self.interval_ms.max(1)),
            device_address: self.device_address,
            tag: self.clone(),
        }
    }
}

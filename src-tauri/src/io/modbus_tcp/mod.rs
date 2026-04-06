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

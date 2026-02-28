// io/modbus_tcp/mod.rs
//
// Modbus TCP client driver for polling registers and scanning Modbus devices.
// - Reader: catalog-driven polling of known registers
// - Scanner: one-shot discovery of registers and active unit IDs

mod reader;
pub mod scanner;

pub use reader::{ModbusTcpConfig, ModbusTcpReader, PollGroup, RegisterType};
pub use scanner::{
    ModbusScanConfig, ScanCompletePayload, UnitIdScanConfig,
};

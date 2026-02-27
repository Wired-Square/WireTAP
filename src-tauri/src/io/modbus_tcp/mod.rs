// io/modbus_tcp/mod.rs
//
// Modbus TCP client driver for polling registers from Modbus TCP servers.
// Catalog-driven: poll groups are derived from [frame.modbus.*] catalog entries
// and passed by the frontend when starting a session.

mod reader;

pub use reader::{ModbusTcpConfig, ModbusTcpReader, PollGroup};

// io/modbus_rtu/mod.rs
//
// Modbus RTU master driver for polling registers over serial.
// Uses raw serial I/O with Modbus RTU framing (CRC-16).

mod reader;

pub use reader::{ModbusRtuConfig, ModbusRtuReader};

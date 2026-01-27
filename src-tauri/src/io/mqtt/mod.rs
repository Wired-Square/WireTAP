// ui/src-tauri/src/io/mqtt/mod.rs
//
// MQTT reader for streaming CAN frames from an MQTT broker.
// Supports SavvyCAN JSON format with optional CAN FD.

mod reader;

// Re-export public items
pub use reader::{MqttConfig, MqttReader};

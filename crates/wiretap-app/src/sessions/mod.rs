// ui/crates/wiretap-app/src/sessions/mod.rs
//
// Tauri commands for IO session lifecycle.
// Handles session creation, control (start/stop/pause/resume), and destruction.

mod commands;
mod ids;
mod source_config;
mod tracking;
pub use commands::*;
pub use ids::*;
pub use source_config::*;
pub use tracking::*;

#[cfg(test)]
use crate::settings::IOProfile;

/// Minimal profile — only the fields the bus enumeration reads.
#[cfg(test)]
fn profile(kind: &str, connection: serde_json::Value) -> IOProfile {
    IOProfile {
        id: format!("p-{}", kind),
        name: kind.to_string(),
        kind: kind.to_string(),
        connection: connection
            .as_object()
            .expect("connection must be an object")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        preferred_catalog: None,
        ephemeral: false,
    }
}

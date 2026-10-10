// Copyright 2026 Wired Square Pty Ltd

use tauri::AppHandle;

use crate::settings;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Whether applying the saved settings would change the running server
    /// (start/stop it, or restart with different gates/port/token). Computed in
    /// Rust, which owns both the running config and the saved settings, so the
    /// UI needn't reconstruct it.
    pub restart_pending: bool,
}

impl McpStatus {
    /// Snapshot the live server state and whether a restart is pending vs the
    /// saved settings.
    fn current(app: &AppHandle) -> Self {
        let restart_pending = settings::load_settings_sync(app)
            .map(|s| {
                let desired = super::McpRunningConfig::from_settings(&s);
                super::restart_pending(s.mcp_server_enabled, desired, &s.mcp_server_token)
            })
            .unwrap_or(false);
        McpStatus {
            running: super::is_running(),
            port: super::running_port(),
            restart_pending,
        }
    }
}

#[tauri::command]
pub fn get_mcp_status(app: AppHandle) -> McpStatus {
    McpStatus::current(&app)
}

/// Start or stop the MCP server, applying the current saved settings. The
/// settings UI saves first, then calls this so port/token/control changes take
/// effect without an app restart.
#[tauri::command]
pub fn toggle_mcp_server(app: AppHandle, enabled: bool) -> Result<McpStatus, String> {
    super::stop();
    if enabled {
        let s = settings::load_settings_sync(&app)?;
        super::start(
            app.clone(),
            super::McpRunningConfig::from_settings(&s),
            s.mcp_server_token.clone(),
        )?;
    }
    Ok(McpStatus::current(&app))
}

/// A fresh bearer token for the MCP server: 24 random bytes as hex.
#[tauri::command]
pub fn generate_mcp_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| format!("No randomness for a token: {e}"))?;
    Ok(hex::encode(bytes))
}

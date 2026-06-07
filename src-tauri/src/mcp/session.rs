// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

//! Rust-native session open for the MCP server. Mirrors the frontend's open
//! flow (build Modbus poll groups from the profile's catalog, then create the
//! reader session) without needing an app window. A keep-alive task touches the
//! MCP subscriber so the session isn't reaped by the heartbeat watchdog.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use crate::io::modbus_tcp::RegisterType;
use crate::io::PollGroup;

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn generate_session_id(kind: &str) -> String {
    let prefix = if kind.starts_with("modbus") {
        "m"
    } else if kind == "serial" {
        "b"
    } else {
        "f"
    };
    format!("{prefix}_mcp{}", SID_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Convert a traditional Modbus register number (1-based, type-prefixed) to a
/// 0-based protocol address. Mirrors `modbusPollBuilder.ts`.
fn traditional_to_protocol(reg: i64, rt: &RegisterType) -> i64 {
    let offset = match rt {
        RegisterType::Coil => 1,
        RegisterType::Discrete => 10001,
        RegisterType::Input => 30001,
        RegisterType::Holding => 40001,
    };
    (reg - offset).max(0)
}

/// Build Modbus poll groups from a catalog's `[frame.modbus.*]` entries.
/// Rust port of `buildPollsFromCatalog` in the frontend.
fn build_modbus_polls(catalog_toml: &str) -> Result<Vec<PollGroup>, String> {
    let v: toml::Value =
        toml::from_str(catalog_toml).map_err(|e| format!("Failed to parse catalog: {e}"))?;
    let meta = v.get("meta").and_then(|m| m.get("modbus"));
    let register_base = meta
        .and_then(|m| m.get("register_base"))
        .and_then(|x| x.as_integer())
        .unwrap_or(0);
    let default_interval = meta
        .and_then(|m| m.get("default_interval"))
        .and_then(|x| x.as_integer())
        .unwrap_or(1000) as u64;

    let frames = match v.get("frame").and_then(|f| f.get("modbus")).and_then(|m| m.as_table()) {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let mut polls = Vec::new();
    for (name, body) in frames {
        if name == "config" {
            continue;
        }
        let Some(body) = body.as_table() else { continue };
        let Some(reg) = body.get("register_number").and_then(|x| x.as_integer()) else { continue };
        let register_type = match body.get("register_type").and_then(|x| x.as_str()).unwrap_or("holding") {
            "input" => RegisterType::Input,
            "coil" => RegisterType::Coil,
            "discrete" => RegisterType::Discrete,
            _ => RegisterType::Holding,
        };
        let count = body.get("length").and_then(|x| x.as_integer()).unwrap_or(1).clamp(1, 65535) as u16;
        let interval_ms = body
            .get("tx")
            .and_then(|t| t.get("interval_ms").or_else(|| t.get("interval")))
            .and_then(|x| x.as_integer())
            .map(|n| n as u64)
            .unwrap_or(default_interval);
        let start = if register_base == 1 {
            traditional_to_protocol(reg, &register_type)
        } else {
            reg
        };
        polls.push(PollGroup {
            register_type,
            start_register: start.clamp(0, 65535) as u16,
            count,
            interval_ms,
            frame_id: reg.clamp(0, u32::MAX as i64) as u32,
        });
    }
    Ok(polls)
}

/// Touch the MCP subscriber every 10s so the heartbeat watchdog doesn't reap a
/// headless session. Self-terminates once the session is gone.
fn spawn_keepalive(session_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if crate::io::get_session_state(&session_id).await.is_none() {
                break;
            }
            crate::io::touch_subscriber_heartbeats(std::slice::from_ref(&session_id)).await;
        }
    });
}

/// Open (create + auto-start) a reader session for a profile. For Modbus
/// profiles, poll groups are built from the profile's preferred catalog.
pub async fn open(
    app: tauri::AppHandle,
    profile_id: String,
    session_id: Option<String>,
) -> Result<Value, String> {
    let settings = crate::settings::load_settings_sync(&app)?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    let modbus_polls = if profile.kind.starts_with("modbus") {
        let catalog = profile.preferred_catalog.clone().ok_or_else(|| {
            "Modbus profile has no preferred_catalog — set one so poll groups can be built".to_string()
        })?;
        let path = std::path::PathBuf::from(&settings.decoder_dir).join(&catalog);
        let toml = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read catalog '{catalog}': {e}"))?;
        let polls = build_modbus_polls(&toml)?;
        if polls.is_empty() {
            return Err(format!("Catalog '{catalog}' has no [frame.modbus.*] poll definitions"));
        }
        Some(serde_json::to_string(&polls).map_err(|e| e.to_string())?)
    } else {
        None
    };

    let sid = session_id.unwrap_or_else(|| generate_session_id(&profile.kind));
    let capabilities = crate::sessions::create_reader_session(
        app.clone(),
        sid.clone(),
        Some(profile_id.clone()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("mcp".to_string()),
        Some("mcp".to_string()),
        modbus_polls,
    )
    .await?;

    spawn_keepalive(sid.clone());

    Ok(json!({ "session_id": sid, "profile_id": profile_id, "capabilities": capabilities }))
}

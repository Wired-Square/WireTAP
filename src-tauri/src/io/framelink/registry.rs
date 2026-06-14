// Copyright 2026 Wired Square Pty Ltd
//
// WS command surface for the framelink-rs device registry. The registry
// (single source of truth, owned by the library at the platform config dir)
// records which devices exist and how to reach them — `auto` (resolve via
// mDNS) or `manual` (connect to a stored host, never discover). This module
// is thin glue: it translates WS JSON to/from `framelink::DeviceRegistry`
// and never duplicates registry logic.

use std::net::IpAddr;

use serde_json::{json, Value};

use framelink::{DeviceRecord, DeviceRegistry, Resolution};

use super::shared::get_device_id;

/// Serialise a record to the JSON shape the frontend consumes.
fn record_json(rec: &DeviceRecord) -> Value {
    json!({
        "device_id": rec.name,
        "resolution": match rec.resolution {
            Resolution::Auto => "auto",
            Resolution::Manual => "manual",
        },
        "host": rec.host.map(|h| h.to_string()),
        "framelink_port": rec.framelink_port,
        "smp_port": rec.smp_port,
    })
}

pub async fn dispatch_registry_command(
    op_name: &str,
    params: Value,
) -> Result<Value, String> {
    match op_name {
        "registry.list" => cmd_list(),
        "registry.get" => cmd_get(params),
        "registry.upsert" => cmd_upsert(params),
        "registry.remove" => cmd_remove(params),
        _ => Err(format!("Unknown registry command: {op_name}")),
    }
}

fn cmd_list() -> Result<Value, String> {
    let registry = DeviceRegistry::open().map_err(|e| format!("open registry: {e}"))?;
    let rows: Vec<Value> = registry.list().map(record_json).collect();
    Ok(Value::Array(rows))
}

fn cmd_get(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let registry = DeviceRegistry::open().map_err(|e| format!("open registry: {e}"))?;
    Ok(registry.get(&device_id).map(record_json).unwrap_or(Value::Null))
}

/// Register or update a device. `resolution: "manual"` requires `host` (an
/// IP); optional `framelink_port` / `smp_port` override the defaults.
/// `resolution: "auto"` clears the stored host.
fn cmd_upsert(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let resolution = params["resolution"]
        .as_str()
        .ok_or("missing 'resolution' ('auto' or 'manual')")?;

    let record = match resolution {
        "auto" => DeviceRecord::auto(device_id),
        "manual" => {
            let host: IpAddr = params["host"]
                .as_str()
                .ok_or("manual resolution requires 'host'")?
                .parse()
                .map_err(|e| format!("invalid host IP: {e}"))?;
            let mut rec = DeviceRecord::manual(device_id, host);
            if let Some(p) = port_param(&params, "framelink_port")? {
                rec.framelink_port = p;
            }
            if let Some(p) = port_param(&params, "smp_port")? {
                rec.smp_port = p;
            }
            rec
        }
        other => return Err(format!("invalid resolution '{other}' (expected 'auto' or 'manual')")),
    };

    let mut registry = DeviceRegistry::open().map_err(|e| format!("open registry: {e}"))?;
    registry.upsert(record);
    registry.save().map_err(|e| format!("save registry: {e}"))?;
    Ok(json!({ "ok": true }))
}

fn cmd_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let mut registry = DeviceRegistry::open().map_err(|e| format!("open registry: {e}"))?;
    let removed = registry.remove(&device_id).is_some();
    if removed {
        registry.save().map_err(|e| format!("save registry: {e}"))?;
    }
    Ok(json!({ "removed": removed }))
}

/// Read an optional u16 port field, rejecting out-of-range numbers.
fn port_param(params: &Value, key: &str) -> Result<Option<u16>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| format!("'{key}' must be a number"))?;
            u16::try_from(n)
                .ok()
                .filter(|p| *p != 0)
                .map(Some)
                .ok_or_else(|| format!("'{key}' out of range (1-65535)"))
        }
    }
}
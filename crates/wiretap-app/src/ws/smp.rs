// Copyright 2026 Wired Square Pty Ltd

//! WS dispatch surface for SMP/OTA: `list_images`, `ota_start` and
//! `ota_cancel`. Firmware upgrade waits on wslib-mcumgr, so every op fails.

pub async fn dispatch(
    op: &str,
    _params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match op {
        "smp.list_images" | "smp.ota_start" | "smp.ota_cancel" => {
            Err("firmware upgrade unavailable in this build".into())
        }
        _ => Err(format!("Unknown smp op: {op}")),
    }
}

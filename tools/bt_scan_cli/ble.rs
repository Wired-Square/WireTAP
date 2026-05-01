// Cross-platform BLE discovery via btleplug.
//
// Subscribes to CentralEvent stream so we capture each advertisement
// as it arrives (more reliable than polling, especially on Windows
// WinRT). Highlights Framelink devices via framelink::ble.

use std::collections::HashSet;
use std::time::Duration;

use btleplug::api::{Central, CentralEvent, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Manager, Peripheral};
use framelink::ble::{parse_peripheral, FRAMELINK_BLE_SERVICE_UUID};
use futures::StreamExt;

use crate::{name_looks_framelink, Cli, Discovered};

pub async fn print_radios() {
    println!("--- BLE radios (btleplug) ---");
    match Manager::new().await {
        Ok(m) => match m.adapters().await {
            Ok(adapters) => {
                println!("  count: {}", adapters.len());
                for (i, a) in adapters.iter().enumerate() {
                    let info = a
                        .adapter_info()
                        .await
                        .unwrap_or_else(|e| format!("<adapter_info failed: {e}>"));
                    println!("  [{i}] {info}");
                }
                if adapters.is_empty() {
                    println!("  (no BLE adapter found by btleplug)");
                }
            }
            Err(e) => println!("  manager.adapters() failed: {e}"),
        },
        Err(e) => println!("  Manager::new() failed: {e}"),
    }
    println!("  Framelink primary service UUID (matched against): {FRAMELINK_BLE_SERVICE_UUID}");
}

pub async fn scan(cli: Cli) -> Vec<Discovered> {
    let mut summary = Vec::new();

    let manager = match Manager::new().await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[ble] Manager::new() failed: {e}");
            return summary;
        }
    };
    let adapter = match manager.adapters().await.ok().and_then(|a| a.into_iter().next()) {
        Some(a) => a,
        None => {
            eprintln!("[ble] no BLE adapter");
            return summary;
        }
    };

    let mut events = match adapter.events().await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[ble] adapter.events() failed: {e}");
            return summary;
        }
    };

    if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
        eprintln!("[ble] start_scan failed: {e}");
        return summary;
    }

    println!("[ble] scanning for {}s...", cli.timeout_secs);

    let deadline = std::time::Instant::now() + Duration::from_secs(cli.timeout_secs);
    let mut seen = HashSet::<String>::new();
    let mut event_count = 0u64;
    let mut last_poll = std::time::Instant::now();

    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline - now;

        match tokio::time::timeout(Duration::from_millis(250).min(remaining), events.next()).await
        {
            Ok(Some(event)) => {
                event_count += 1;
                if let CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) = event
                {
                    let id_s = id.to_string();
                    if !seen.insert(id_s.clone()) {
                        continue;
                    }
                    if let Ok(p) = adapter.peripheral(&id).await {
                        if let Some(d) = inspect(&p, &cli).await {
                            summary.push(d);
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(_) => {
                // Belt-and-braces poll once a second in case events are missed.
                if now.duration_since(last_poll) >= Duration::from_secs(1) {
                    last_poll = now;
                    if let Ok(peripherals) = adapter.peripherals().await {
                        for p in peripherals {
                            let id_s = p.id().to_string();
                            if !seen.insert(id_s) {
                                continue;
                            }
                            if let Some(d) = inspect(&p, &cli).await {
                                summary.push(d);
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = adapter.stop_scan().await;

    println!(
        "[ble] scan complete: {} central events, {} unique peripherals",
        event_count,
        summary.len()
    );
    summary
}

async fn inspect(peripheral: &Peripheral, cli: &Cli) -> Option<Discovered> {
    let ble_id = peripheral.id().to_string();
    let props = peripheral.properties().await.ok().flatten()?;

    // btleplug 0.12 splits the advertised name (from ADV/SCAN_RSP payloads)
    // from local_name (post-connect GAP characteristic). The advertised
    // name is the only one we have pre-connect, so prefer it.
    let name = props
        .advertisement_name
        .clone()
        .or_else(|| props.local_name.clone())
        .unwrap_or_else(|| "<unnamed>".into());
    // Diagnostic — show which field carried the name (or that both are None).
    let name_diag = format!(
        "advertisement_name={:?} local_name={:?}",
        props.advertisement_name, props.local_name
    );
    // Match FrameLink directly off the service UUID (advertisement or
    // service-data) — the constant is a plain `uuid::Uuid` so it doesn't
    // cross the btleplug 0.11/0.12 boundary that blocks parse_peripheral.
    let has_framelink_uuid = props.services.contains(&FRAMELINK_BLE_SERVICE_UUID)
        || props.service_data.contains_key(&FRAMELINK_BLE_SERVICE_UUID);
    let is_named = name != "<unnamed>";
    // Show framelink-matching peripherals even when verbose is off, so the
    // device the user actually cares about isn't buried under --verbose.
    if !is_named && !has_framelink_uuid && !cli.verbose {
        return None;
    }
    if let Some(needle) = &cli.filter {
        let needle_lc = needle.to_lowercase();
        let names = [
            props.advertisement_name.as_deref(),
            props.local_name.as_deref(),
        ];
        if !names
            .iter()
            .flatten()
            .any(|n| n.to_lowercase().contains(&needle_lc))
        {
            return None;
        }
    }

    let parsed = parse_peripheral(ble_id.clone(), &props);
    let framelink = parsed.is_some() || has_framelink_uuid || name_looks_framelink(&name);

    println!();
    println!("--- BLE peripheral ---");
    println!("  name        : {name}");
    println!("  name_fields : {name_diag}");
    println!("  ble_id      : {ble_id}");
    println!("  rssi        : {:?}", props.rssi);
    println!("  tx_power    : {:?}", props.tx_power_level);
    println!("  address_type: {:?}", props.address_type);
    println!("  services    : {:?}", props.services);
    if cli.detail {
        println!("  service_data:");
        for (uuid, bytes) in &props.service_data {
            println!("    {uuid} = {} bytes [{}]", bytes.len(), hex_str(bytes));
        }
        println!("  manufacturer_data:");
        for (cid, bytes) in &props.manufacturer_data {
            println!(
                "    [0x{cid:04x} {}] {} bytes = {}",
                company_name(*cid),
                bytes.len(),
                hex_str(bytes)
            );
        }
    } else {
        println!(
            "  service_data: {:?}",
            props.service_data.keys().collect::<Vec<_>>()
        );
        println!(
            "  manufacturer: {}",
            props
                .manufacturer_data
                .keys()
                .map(|c| format!("0x{c:04x} {}", company_name(*c)))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    if let Some(d) = &parsed {
        let caps = d
            .payload
            .as_ref()
            .map(|p| capability_list(p.capabilities))
            .unwrap_or_else(|| vec!["<no payload>".into()]);
        println!("  >> framelink-matched (BLE)");
        println!("     parsed_name: {}", d.name);
        println!("     caps       : {caps:?}");
        if cli.detail {
            println!("     payload    : {:?}", d.payload);
        }
    } else if has_framelink_uuid {
        println!("  >> framelink-matched (BLE service UUID present)");
    } else if framelink {
        println!("  >> framelink-matched (name pattern only — no BLE service UUID)");
    }

    if cli.detail && is_named {
        // Try a connect+enumerate for a deeper picture. Best-effort: skip silently on failure.
        if let Err(e) = peripheral.connect().await {
            println!("  [detail] connect failed: {e}");
        } else {
            if let Err(e) = peripheral.discover_services().await {
                println!("  [detail] discover_services failed: {e}");
            } else {
                let services = peripheral.services();
                println!("  [detail] GATT services: {}", services.len());
                for s in services {
                    println!("    service {}", s.uuid);
                    for c in s.characteristics {
                        println!(
                            "      char {} props={:?}",
                            c.uuid, c.properties
                        );
                    }
                }
            }
            let _ = peripheral.disconnect().await;
        }
    }

    Some(Discovered {
        label: format!("{name} ({ble_id})"),
        framelink,
    })
}

fn hex_str(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn capability_list(caps: framelink::ble::CapabilityFlags) -> Vec<String> {
    let mut out = Vec::new();
    if caps.has_wifi_prov() {
        out.push("wifi-prov".into());
    }
    if caps.has_smp() {
        out.push("smp".into());
    }
    if caps.has_framelink_ble() {
        out.push("framelink-ble".into());
    }
    if caps.has_caps() {
        out.push("caps".into());
    }
    out
}

/// Tiny lookup of the most common Bluetooth SIG company IDs we'd see
/// in an advertisement. Unknown IDs print as "vendor".
fn company_name(id: u16) -> &'static str {
    match id {
        0x0006 => "Microsoft",
        0x004c => "Apple",
        0x000f => "Broadcom",
        0x0075 => "Samsung",
        0x00e0 => "Google",
        0x0157 => "Anhui Huami",
        0x02e5 => "Espressif",
        0x0590 => "Wired Square (?)", // placeholder — fix when confirmed
        _ => "vendor",
    }
}

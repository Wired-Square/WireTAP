// bt_scan_cli — cross-platform BLE diagnostic CLI.
//
// Identifies the host's BLE radio(s), then runs BLE discovery and
// prints everything visible. FrameLink devices are highlighted via
// framelink::ble::parse_peripheral (FrameLink primary service UUID +
// Manufacturer Data capability bitmask), with a name-pattern fallback.
//
// Goal: triage "is the host BT stack functional?" vs "is WireTAP's
// scan code at fault?" — separates radio/driver issues from
// firmware/parser issues, regardless of platform.

mod ble;
mod tui;

use std::time::Instant;

use clap::Parser;

#[derive(Parser, Clone)]
#[command(
    name = "bt_scan_cli",
    about = "Cross-platform BLE diagnostic — radio info + peripheral discovery"
)]
struct Cli {
    /// BLE discovery duration in seconds.
    #[arg(long, default_value = "15")]
    timeout_secs: u64,

    /// Print every BLE peripheral, including unnamed ones.
    #[arg(long)]
    verbose: bool,

    /// Only show BLE peripherals whose advertised name contains this
    /// substring (case-insensitive). Implies named-only.
    #[arg(long, value_name = "SUBSTRING")]
    filter: Option<String>,

    /// Pull every detail we can — full advertisement contents, GATT
    /// enumeration, vendor lookups. Slower.
    #[arg(long)]
    detail: bool,

    /// Live BLE TUI (ratatui). Runs until `q`/Esc. `--filter` sets the
    /// initial filter; `/` edits it interactively.
    #[arg(long)]
    tui: bool,
}

pub(crate) const FRAMELINK_NAME_PATTERN: &str = "WiredFlexLink";

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.tui {
        if let Err(e) = tui::run(cli.filter.clone(), cli.detail).await {
            eprintln!("[tui] fatal: {e}");
            std::process::exit(1);
        }
        return;
    }

    println!("=== Bluetooth Stack ===");
    println!(
        "[ host: {} {} ]",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!();
    ble::print_radios().await;
    println!();

    println!(
        "=== Discovery ({}s{}) ===",
        cli.timeout_secs,
        if cli.detail { ", --detail" } else { "" }
    );
    let started = Instant::now();

    let ble_devices = ble::scan(cli).await;

    println!();
    println!("=== Summary ===");
    let ble_total = ble_devices.len();
    let ble_framelink = ble_devices.iter().filter(|d| d.framelink).count();
    println!("  scan duration       : {:?}", started.elapsed());
    println!("  BLE peripherals     : {ble_total} ({ble_framelink} framelink)");

    if ble_framelink > 0 {
        println!();
        println!("  Framelink devices:");
        for d in ble_devices.iter().filter(|d| d.framelink) {
            println!("    [BLE] {}", d.label);
        }
    }

    if ble_total == 0 {
        println!();
        println!("  Nothing visible. Either the host BT stack isn't delivering");
        println!("  events, or no devices are advertising / discoverable.");
    }
}

/// Aggregate per-device record for the summary tally.
pub(crate) struct Discovered {
    /// Display label (name + address).
    pub label: String,
    pub framelink: bool,
}

/// Returns true if a friendly name looks like a Framelink device.
/// Used as a fallback when the BLE service UUID isn't present in the
/// advertisement (e.g. when only manufacturer-data identifies the device).
pub(crate) fn name_looks_framelink(name: &str) -> bool {
    name.contains(FRAMELINK_NAME_PATTERN)
}

// bt_scan_cli — diagnostic CLI for FrameLink device discovery.
//
// Drives the framelink::Discovery API and renders a live view of every
// FrameLink device visible over BLE or mDNS. Used as the contract validator
// for framelink-rs's discovery surface — anything that's wrong with the
// public API tends to surface here first.
//
// Phase 1 scope: FrameLink devices only. The previous standalone-btleplug
// "all visible peripherals" detail mode and the per-device GATT enumeration
// are Phase 5 nice-to-haves (will arrive when this binary's role folds into
// `framelink-cli scan --detail`).

mod tui;

use clap::Parser;
use framelink::{Discovery, DiscoveryEvent};
use tokio_stream::StreamExt;

#[derive(Parser, Clone)]
#[command(
    name = "bt_scan_cli",
    about = "FrameLink discovery diagnostic — drives framelink::Discovery and prints/renders what it sees"
)]
struct Cli {
    /// Discovery duration in seconds for the non-TUI streaming mode.
    /// Ignored in `--tui` mode (TUI runs until `q`/Esc).
    #[arg(long, default_value = "15")]
    timeout_secs: u64,

    /// Live TUI (ratatui) instead of the default stream-to-stdout mode.
    #[arg(long)]
    tui: bool,
}

#[tokio::main]
async fn main() {
    // Route framelink-rs's tracing output to stderr so it doesn't interleave
    // with the events we print on stdout. Subscriber init failure is
    // non-fatal — we just won't see internal diagnostics.
    init_tracing();

    let cli = Cli::parse();

    if cli.tui {
        if let Err(e) = tui::run().await {
            eprintln!("[tui] fatal: {e}");
            std::process::exit(1);
        }
        return;
    }

    if let Err(e) = stream_mode(cli.timeout_secs).await {
        eprintln!("[scan] fatal: {e}");
        std::process::exit(1);
    }
}

async fn stream_mode(timeout_secs: u64) -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "[ host: {} {} ]    bt_scan_cli — FrameLink discovery (timeout {}s)",
        std::env::consts::OS,
        std::env::consts::ARCH,
        timeout_secs,
    );

    let discovery = Discovery::start().await?;
    let mut events = discovery.events();
    let mut deadline = Box::pin(tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)));

    let mut seen_count = 0usize;
    loop {
        tokio::select! {
            biased;
            _ = &mut deadline => {
                println!();
                println!("=== Summary ===");
                let snap = discovery.devices().await;
                println!("  duration                   : {timeout_secs}s");
                println!("  unique Seen events         : {seen_count}");
                println!("  currently-known devices    : {}", snap.len());
                if snap.is_empty() {
                    println!();
                    println!("  Nothing visible. Either no FrameLink devices are advertising,");
                    println!("  or the host BT/mDNS stack isn't delivering events.");
                } else {
                    println!();
                    println!("  Final snapshot:");
                    for d in snap {
                        println!(
                            "    {:<32}  {:<12}  {:<22}  rssi={}",
                            d.name(),
                            d.transports()
                                .iter()
                                .map(|t| t.to_string())
                                .collect::<Vec<_>>()
                                .join(","),
                            d.capabilities().to_string(),
                            d.rssi().map(|r| r.to_string()).unwrap_or_else(|| "—".into()),
                        );
                    }
                }
                return Ok(());
            }
            Some(evt) = events.next() => {
                match evt {
                    DiscoveryEvent::Seen { device } => {
                        seen_count += 1;
                        println!(
                            "+ Seen     id={}  name={:?}  transports={:?}  caps=[{}]  rssi={:?}",
                            device.id(),
                            device.name(),
                            device.transports(),
                            device.capabilities(),
                            device.rssi(),
                        );
                    }
                    DiscoveryEvent::Updated { id, name, capabilities, rssi } => {
                        println!(
                            "~ Updated  id={id}  name={name:?}  caps=[{capabilities}]  rssi={rssi:?}"
                        );
                    }
                    DiscoveryEvent::Lost { id } => {
                        println!("- Lost     id={id}");
                    }
                    DiscoveryEvent::Error { source, message } => {
                        eprintln!("! Error    source={source:?}  message={message}");
                    }
                }
            }
            else => break,
        }
    }
    Ok(())
}

fn init_tracing() {
    // Best-effort: if a subscriber is already installed (e.g. by a hosting
    // process), this returns Err and we just continue without one.
    use tracing_subscriber::fmt;
    let _ = fmt()
        .with_writer(std::io::stderr)
        .with_target(true)
        .compact()
        .try_init();
}

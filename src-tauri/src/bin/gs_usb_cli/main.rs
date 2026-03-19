// gs_usb_cli — diagnostic CLI for gs_usb CAN adapters.
//
// Bypasses the Tauri/UI stack to give direct control over USB transfers
// for diagnosing frame loss and protocol issues.

mod commands;
mod usb_diag;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "gs_usb_cli", about = "Diagnostic CLI for gs_usb CAN adapters")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List all connected gs_usb devices
    List,

    /// Probe a device for capabilities
    Probe {
        /// Device address as bus:addr (e.g., 0:5)
        device: String,
        /// Match by serial number instead of bus:addr
        #[arg(long)]
        serial: Option<String>,
    },

    /// Show USB descriptor topology
    Topology {
        /// Device address as bus:addr (e.g., 0:5)
        device: String,
        /// Match by serial number instead of bus:addr
        #[arg(long)]
        serial: Option<String>,
    },

    /// Receive CAN frames with per-transfer diagnostics
    Receive {
        /// Device address as bus:addr (e.g., 0:5)
        device: String,
        /// CAN bitrate in bps
        #[arg(long, default_value = "500000")]
        bitrate: u32,
        /// CAN channel (usually 0)
        #[arg(long, default_value = "0")]
        channel: u8,
        /// Enable listen-only mode (no ACK)
        #[arg(long)]
        listen_only: bool,
        /// Stop after N frames
        #[arg(long)]
        count: Option<u64>,
        /// Match by serial number instead of bus:addr
        #[arg(long)]
        serial: Option<String>,
        /// Sample point percentage
        #[arg(long, default_value = "87.5")]
        sample_point: f32,
        /// Override CAN clock frequency in Hz (use when firmware reports wrong clock)
        #[arg(long)]
        can_clock: Option<u32>,
    },

    /// Send a single CAN frame
    Send {
        /// Device address as bus:addr (e.g., 0:5)
        device: String,
        /// CAN ID (hex, e.g., 100 or 1ABCDEF)
        can_id: String,
        /// Frame data as hex (e.g., DEADBEEF)
        hex_data: String,
        /// CAN bitrate in bps
        #[arg(long, default_value = "500000")]
        bitrate: u32,
        /// CAN channel (usually 0)
        #[arg(long, default_value = "0")]
        channel: u8,
        /// Send as extended (29-bit) frame
        #[arg(long)]
        extended: bool,
        /// Match by serial number instead of bus:addr
        #[arg(long)]
        serial: Option<String>,
        /// Override CAN clock frequency in Hz (use when firmware reports wrong clock)
        #[arg(long)]
        can_clock: Option<u32>,
    },
}

fn parse_bus_addr(s: &str) -> Result<(u8, u8), String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("Expected bus:addr format (e.g., 0:5), got '{}'", s));
    }
    let bus = parts[0]
        .parse::<u8>()
        .map_err(|_| format!("Invalid bus number: '{}'", parts[0]))?;
    let addr = parts[1]
        .parse::<u8>()
        .map_err(|_| format!("Invalid address: '{}'", parts[1]))?;
    Ok((bus, addr))
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::List => commands::cmd_list(),

        Commands::Probe { device, serial } => {
            let (bus, addr) = match parse_bus_addr(&device) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(1);
                }
            };
            commands::cmd_probe(bus, addr, serial.as_deref())
        }

        Commands::Topology { device, serial } => {
            let (bus, addr) = match parse_bus_addr(&device) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(1);
                }
            };
            commands::cmd_topology(bus, addr, serial.as_deref())
        }

        Commands::Receive {
            device,
            bitrate,
            channel,
            listen_only,
            count,
            serial,
            sample_point,
            can_clock,
        } => {
            let (bus, addr) = match parse_bus_addr(&device) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(1);
                }
            };
            commands::cmd_receive(
                bus,
                addr,
                serial.as_deref(),
                bitrate,
                channel,
                listen_only,
                count,
                sample_point,
                can_clock,
            )
            .await
        }

        Commands::Send {
            device,
            can_id,
            hex_data,
            bitrate,
            channel,
            extended,
            serial,
            can_clock,
        } => {
            let (bus, addr) = match parse_bus_addr(&device) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(1);
                }
            };
            commands::cmd_send(
                bus,
                addr,
                serial.as_deref(),
                &can_id,
                &hex_data,
                bitrate,
                channel,
                extended,
                can_clock,
            )
            .await
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}

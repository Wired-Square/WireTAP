mod candump;
mod cangen;
mod cansend;
mod iface;
mod pattern;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod usb_diag;

use std::{
    io::{self, Write},
    process::ExitCode,
    time::Duration,
};

use clap::{Parser, Subcommand};
use tokio::time::{sleep, Instant};
use wiretap_io::can::{CanEvent, CanWriter};

use crate::iface::{BusOptions, Interface, Probed};

/// can-utils for every WireTAP CAN transport.
///
/// Interfaces: gsusb:<serial>[/<channel>], gsusb:<bus:addr>[/<channel>],
/// pcan:<serial>[/<channel>], pcan:<bus:addr>[/<channel>], slcan:<port>,
/// socketcan:<if> (Linux), gvret:<host:port>.
#[derive(Parser)]
#[command(name = "wiretap-can-cli", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
    #[command(flatten)]
    bus: BusOptions,
}

#[derive(Subcommand)]
enum Command {
    /// List gs_usb and PEAK adapters, serial ports and SocketCAN interfaces
    List,
    /// Ask a device what it is, without starting its channel
    Probe { interface: Interface },
    /// Print frames as `candump -L` does
    Dump {
        interface: Interface,
        /// Also print this host's own sends, and mark each line T or R
        #[arg(long)]
        own: bool,
        /// Stop after this many frames
        #[arg(long)]
        count: Option<u64>,
    },
    /// Send one frame in cansend syntax: 123#DEADBEEF, 12345678#.., 123##1<data>, 123#R
    Send { interface: Interface, frame: String },
    /// Generate frames as cangen does, deterministic modes only
    Gen {
        interface: Interface,
        #[command(flatten)]
        args: cangen::GenArgs,
    },
    /// Run one end of a Test Pattern exchange
    Pattern {
        interface: Interface,
        #[arg(value_enum)]
        role: Role,
        #[arg(long, value_enum, default_value_t = pattern::Mode::Echo)]
        mode: pattern::Mode,
        /// Seconds; an initiator's run length [default: 10], a responder's
        /// lifetime [default: until Ctrl-C]
        #[arg(long)]
        duration: Option<f64>,
        /// Frames per second [default: 100, latency 10, throughput unpaced]
        #[arg(long)]
        rate: Option<f64>,
        /// Framed messages on 29-bit ids
        #[arg(long)]
        extended: bool,
    },
    /// gs_usb adapter diagnostics
    Gsusb {
        #[command(subcommand)]
        command: GsUsbCommand,
    },
}

#[derive(Subcommand)]
enum GsUsbCommand {
    /// USB descriptors, device config, BT_CONST and bulk endpoints
    Diag { interface: Interface },
}

#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum Role {
    Responder,
    Initiator,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("wiretap-can-cli: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Whether the command passed; only a Test Pattern initiator can fail without an error.
async fn run(cli: Cli) -> Result<bool, String> {
    let bus = cli.bus;
    match cli.command {
        Command::List => list(),
        Command::Probe { interface } => probe(&interface).await,
        Command::Dump {
            interface,
            own,
            count,
        } => dump(&interface, &bus, own, count).await,
        Command::Send { interface, frame } => {
            let frame = cansend::parse(&frame, interface.bus())?;
            let task = iface::open(&interface, &bus, false, false).await?;
            let sent = iface::send(&task.writer(), frame).await;
            task.stop().await;
            sent
        }
        Command::Gen { interface, args } => {
            let frames = cangen::Generator::new(&args, interface.bus())?;
            let task = iface::open(&interface, &bus, false, false).await?;
            let sent = generate(&task.writer(), frames, &args).await;
            task.stop().await;
            sent
        }
        Command::Pattern {
            interface,
            role,
            mode,
            duration,
            rate,
            extended,
        } => {
            let reopen = role == Role::Responder;
            let mut link =
                pattern::TaskLink::new(iface::open(&interface, &bus, false, reopen).await?);
            let passed = match role {
                Role::Responder => {
                    let until = duration.map(|s| Instant::now() + Duration::from_secs_f64(s));
                    tokio::select! {
                        answered = pattern::respond(&mut link, interface.bus(), bus.fd(), until) => {
                            let responder = answered?;
                            println!("{}", pattern::counters(&responder.sequence, responder.tx_count));
                        }
                        _ = stop_requested() => {}
                    }
                    true
                }
                Role::Initiator => {
                    let config = pattern::InitiatorConfig {
                        mode,
                        duration: Duration::from_secs_f64(duration.unwrap_or(10.0)),
                        rate_hz: rate.unwrap_or(mode.default_rate()),
                        bus: interface.bus(),
                        fd: bus.fd(),
                        extended,
                    };
                    let outcome = pattern::initiate(&mut link, config).await?;
                    println!("{}", outcome.report());
                    outcome.passed()
                }
            };
            link.stop().await;
            return Ok(passed);
        }
        Command::Gsusb {
            command: GsUsbCommand::Diag { interface },
        } => gs_usb_diag(&interface),
    }?;
    Ok(true)
}

/// Ctrl-C, or SIGTERM where there is one: a process killed past this skips the
/// device's close and leaves the adapter on the bus.
async fn stop_requested() {
    #[cfg(unix)]
    if let Ok(mut term) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Each frame waits for the device to take the last, then for the gap, as
/// cangen's relative timing does.
async fn generate(
    writer: &CanWriter,
    frames: cangen::Generator,
    args: &cangen::GenArgs,
) -> Result<(), String> {
    let gap = Duration::from_secs_f64(args.gap_ms.max(0.0) / 1000.0);
    let count = args.count.unwrap_or(u64::MAX);
    let mut sent = 0;
    let stopped = stop_requested();
    tokio::pin!(stopped);
    for frame in frames.take(count.try_into().unwrap_or(usize::MAX)) {
        tokio::select! {
            _ = &mut stopped => break,
            answer = iface::send(writer, frame) => {
                if let Err(e) = answer {
                    eprintln!("stopped after {sent} frames");
                    return Err(e);
                }
            }
        }
        sent += 1;
        if !gap.is_zero() {
            sleep(gap).await;
        }
    }
    eprintln!("sent {sent} frames");
    Ok(())
}

async fn dump(
    interface: &Interface,
    bus: &BusOptions,
    own: bool,
    count: Option<u64>,
) -> Result<(), String> {
    let mut task = iface::open(interface, bus, own, true).await?;
    let name = candump::ifname(&interface.to_string());
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut left = count.unwrap_or(u64::MAX);
    let stopped = stop_requested();
    tokio::pin!(stopped);
    while left > 0 {
        let event = tokio::select! {
            _ = &mut stopped => break,
            event = task.next_event() => event,
        };
        match event {
            Some(CanEvent::Read(reads)) => {
                for read in reads.iter().take(left.try_into().unwrap_or(usize::MAX)) {
                    let direction = own.then_some(read.direction);
                    let line = candump::line(read.at, &name, &read.frame, direction);
                    if read.overflow {
                        eprintln!("{interface}: the device dropped frames before {line}");
                    }
                    if writeln!(out, "{line}").is_err() {
                        left = 0;
                        break;
                    }
                    left -= 1;
                }
                if out.flush().is_err() {
                    break;
                }
            }
            Some(CanEvent::Connected(_)) => {}
            Some(CanEvent::Disconnected {
                error, retry_in, ..
            }) => {
                eprintln!("{interface}: {error}");
                if retry_in.is_none() {
                    return Err(error.to_string());
                }
            }
            Some(_) => {}
            None => break,
        }
    }
    drop(out);
    task.stop().await;
    Ok(())
}

async fn probe(interface: &Interface) -> Result<(), String> {
    match iface::probe(interface).await? {
        Probed::Device(info) => {
            let or_unknown = |v: Option<String>| v.unwrap_or_else(|| "unknown".to_owned());
            println!("interface  {interface}");
            println!(
                "buses      {}",
                info.buses.map_or("unknown".to_owned(), |b| b.to_string())
            );
            println!("CAN FD     {}", if info.fd { "yes" } else { "no" });
            println!("firmware   {}", or_unknown(info.firmware));
            println!("hardware   {}", or_unknown(info.hardware));
            println!("serial     {}", or_unknown(info.serial));
            if let Some(clock) = info.clock_hz {
                println!("CAN clock  {clock} Hz");
            }
        }
        #[cfg(target_os = "linux")]
        Probed::Rates(rates) => {
            let rate = |r: Option<u32>| r.map_or("not set".to_owned(), |r| r.to_string());
            println!("interface  {interface}");
            println!("bitrate    {}", rate(rates.nominal));
            println!("dbitrate   {}", rate(rates.data));
        }
    }
    Ok(())
}

fn list() -> Result<(), String> {
    println!("gs_usb");
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    for device in wiretap_io::can::gsusb::devices().map_err(|e| format!("USB: {e}"))? {
        let selector = device
            .serial
            .clone()
            .unwrap_or_else(|| format!("{}:{}", device.bus, device.address));
        println!("  gsusb:{selector:<30} {}", device.product);
    }
    #[cfg(target_os = "linux")]
    for found in wiretap_io::can::gsusb::devices().map_err(|e| format!("sysfs: {e}"))? {
        let device = &found.device;
        let interface = found
            .interface
            .as_deref()
            .map_or("no interface yet".to_owned(), |name| {
                let state = match found.up {
                    Some(true) => " (up)",
                    Some(false) => " (down)",
                    None => "",
                };
                format!("socketcan:{name}{state}")
            });
        println!(
            "  {:<36} {} {}",
            interface,
            device.product,
            device.serial.as_deref().unwrap_or("")
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        println!("PEAK");
        for device in wiretap_io::can::pcan::devices().map_err(|e| format!("USB: {e}"))? {
            let selector = device
                .serial
                .clone()
                .unwrap_or_else(|| format!("{}:{}", device.bus, device.address));
            println!("  pcan:{selector:<31} {}", device.model);
        }
    }

    println!("serial ports");
    for port in wiretap_io::serial::ports().map_err(|e| format!("serial ports: {e}"))? {
        let usb = match &port.kind {
            wiretap_io::serial::PortKind::Usb(usb) => format!(
                "{:04x}:{:04x} {}",
                usb.vid,
                usb.pid,
                usb.product.as_deref().unwrap_or("")
            ),
            _ => String::new(),
        };
        println!("{}", format!("  slcan:{:<30} {usb}", port.path).trim_end());
    }

    #[cfg(target_os = "linux")]
    {
        println!("socketcan");
        for name in socketcan_interfaces() {
            println!("  socketcan:{name}");
        }
    }
    Ok(())
}

/// Every interface whose link type is `ARPHRD_CAN`.
#[cfg(target_os = "linux")]
fn socketcan_interfaces() -> Vec<String> {
    const ARPHRD_CAN: &str = "280";
    let mut names: Vec<String> = std::fs::read_dir("/sys/class/net")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            std::fs::read_to_string(entry.path().join("type"))
                .is_ok_and(|kind| kind.trim() == ARPHRD_CAN)
        })
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn gs_usb_diag(interface: &Interface) -> Result<(), String> {
    let Interface::GsUsb { device, .. } = interface else {
        return Err(format!("{interface} is not a gs_usb interface"));
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        usb_diag::diag(device)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = device;
        Err(
            "gs_usb diagnostics run on macOS and Windows; on Linux read ip -details link"
                .to_owned(),
        )
    }
}

// Subcommand implementations for gs_usb_cli.

use std::time::{Duration, Instant};

use wiretap_io::can::gsusb::{self, GsUsbDevice, GsUsbOptions};
use wiretap_io::can::{CanEvent, CanFrame, CanOptions, CanTask, Direction};

use crate::usb_diag;

// ============================================================================
// list
// ============================================================================

pub fn cmd_list() -> Result<(), String> {
    let devices = gsusb::devices().map_err(|e| format!("Failed to list USB devices: {}", e))?;
    if devices.is_empty() {
        println!("No gs_usb devices found.");
        return Ok(());
    }
    println!("{:<10} {:<30} {}", "BUS:ADDR", "PRODUCT", "SERIAL");
    println!("{}", "-".repeat(60));
    for dev in &devices {
        println!(
            "{:<10} {:<30} {}",
            format!("{}:{}", dev.bus, dev.address),
            dev.product,
            dev.serial.as_deref().unwrap_or("(none)")
        );
    }
    Ok(())
}

// ============================================================================
// probe
// ============================================================================

pub async fn cmd_probe(bus: u8, address: u8, serial: Option<&str>) -> Result<(), String> {
    let info = gsusb::probe(&usb_device(bus, address, serial), Duration::from_secs(2))
        .await
        .map_err(|e| e.to_string())?;
    println!("Probe result for {}:{}", bus, address);
    println!("  Channels: {}", info.buses.unwrap_or(0));
    println!("  SW version: {}", info.firmware.as_deref().unwrap_or("0"));
    println!("  HW version: {}", info.hardware.as_deref().unwrap_or("0"));
    if let Some(clock) = info.clock_hz {
        println!(
            "  CAN clock: {} Hz ({:.1} MHz)",
            clock,
            clock as f64 / 1_000_000.0
        );
        println!("  FD support: {}", info.fd);
    }
    Ok(())
}

// ============================================================================
// topology
// ============================================================================

pub fn cmd_topology(bus: u8, address: u8, serial: Option<&str>) -> Result<(), String> {
    let device_info = usb_diag::find_device(bus, address, serial)?;
    // print_topology opens the device internally for descriptor access
    usb_diag::print_topology(&device_info)?;

    // discover_endpoints also opens the device — separate from topology's open
    match usb_diag::discover_endpoints(&device_info) {
        Ok(eps) => {
            println!("\nDiscovered Bulk Endpoints:");
            println!("  IN:  0x{:02X}", eps.in_addr);
            println!("  OUT: 0x{:02X}", eps.out_addr);
            println!("  Max packet size: {}", eps.max_packet_size);
        }
        Err(e) => println!("\nEndpoint discovery failed: {}", e),
    }

    Ok(())
}

// ============================================================================
// Opening a channel
// ============================================================================

fn usb_device(bus: u8, address: u8, serial: Option<&str>) -> GsUsbDevice {
    GsUsbDevice {
        serial: serial.map(str::to_owned),
        bus,
        address,
        product: String::new(),
    }
}

fn channel_options(
    bus: u8,
    address: u8,
    serial: Option<&str>,
    bitrate: u32,
    channel: u8,
    can_clock: Option<u32>,
) -> GsUsbOptions {
    let mut gs = GsUsbOptions::new(usb_device(bus, address, serial), bitrate);
    gs.channel = channel;
    gs.clock_hz = can_clock;
    gs
}

async fn open(gs: GsUsbOptions, listen_only: bool) -> Result<CanTask, String> {
    if let Some(clk) = gs.clock_hz {
        println!("CAN clock override: {} Hz", clk);
    }
    println!(
        "Opening {}:{} channel {} (bitrate: {}, listen_only: {})",
        gs.device.bus, gs.device.address, gs.channel, gs.bitrate, listen_only
    );
    let mut options = CanOptions::default();
    options.listen_only = listen_only;
    options.own_frames = true;
    options.reopen = None;
    gsusb::open(gs, options).await.map_err(|e| e.to_string())
}

// ============================================================================
// receive
// ============================================================================

/// Prints each frame the library reads, echoes of this host's sends as TX.
pub async fn cmd_receive(
    bus: u8,
    address: u8,
    serial: Option<&str>,
    bitrate: u32,
    channel: u8,
    listen_only: bool,
    count: Option<u64>,
    sample_point: f32,
    can_clock: Option<u32>,
) -> Result<(), String> {
    let mut gs = channel_options(bus, address, serial, bitrate, channel, can_clock);
    gs.sample_point = Some(sample_point);
    let mut task = open(gs, listen_only).await?;

    println!(
        "{:<8} {:<4} {:<4} {:<12} {:<4} {:<4} {:<24} {:<14} {:<10}",
        "#", "DIR", "CH", "CAN_ID", "DLC", "EXT", "DATA", "DEVICE_US", "DELTA_MS"
    );
    println!("{}", "-".repeat(96));

    let mut rx_frames: u64 = 0;
    let mut tx_echoes: u64 = 0;
    let mut last_read = Instant::now();
    let start_time = Instant::now();

    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    let lost = loop {
        if let Some(max) = count.filter(|&max| rx_frames >= max) {
            println!("\nReached frame limit of {}", max);
            break None;
        }

        tokio::select! {
            _ = &mut ctrl_c => {
                println!("\n\nCtrl+C received");
                break None;
            }
            event = task.next_event() => match event {
                Some(CanEvent::Connected(info)) => println!(
                    "Connected: channels {:?}, firmware {}, serial {}, FD {}\n",
                    info.buses,
                    info.firmware.as_deref().unwrap_or("(unknown)"),
                    info.serial.as_deref().unwrap_or("(none)"),
                    info.fd
                ),
                Some(CanEvent::Read(reads)) => {
                    let now = Instant::now();
                    let delta_ms = now.duration_since(last_read).as_secs_f64() * 1000.0;
                    last_read = now;
                    for read in reads {
                        let dir = match read.direction {
                            Direction::Rx => {
                                rx_frames += 1;
                                "RX"
                            }
                            Direction::Tx => {
                                tx_echoes += 1;
                                "TX"
                            }
                        };
                        let frame = read.frame;
                        println!(
                            "{:<8} {:<4} {:<4} 0x{:08X}   {:<4} {:<4} {:<24} {:<14} {:.3}",
                            rx_frames + tx_echoes,
                            dir,
                            frame.bus,
                            frame.arb_id,
                            frame.dlc(),
                            if frame.extended { "EXT" } else { "STD" },
                            hex::encode_upper(&frame.data),
                            read.device_us.map_or("-".to_string(), |us| us.to_string()),
                            delta_ms,
                        );
                    }
                }
                Some(CanEvent::Disconnected { error, .. }) => break Some(error.to_string()),
                None => break Some("the CAN task ended".to_string()),
            }
        }
    };

    let elapsed = start_time.elapsed().as_secs_f64();
    println!("\n=== Final Statistics ===");
    println!("  Duration:   {:.1}s", elapsed);
    println!("  RX frames:  {}", rx_frames);
    println!("  TX echoes:  {}", tx_echoes);

    match lost {
        Some(error) => Err(format!("Device lost: {}", error)),
        None => {
            task.stop().await;
            println!("Device stopped.");
            Ok(())
        }
    }
}

// ============================================================================
// send
// ============================================================================

pub async fn cmd_send(
    bus: u8,
    address: u8,
    serial: Option<&str>,
    can_id_str: &str,
    hex_data_str: &str,
    bitrate: u32,
    channel: u8,
    extended: bool,
    can_clock: Option<u32>,
) -> Result<(), String> {
    let can_id = u32::from_str_radix(can_id_str, 16)
        .map_err(|e| format!("Invalid CAN ID '{}': {}", can_id_str, e))?;
    let data = hex::decode(hex_data_str)
        .map_err(|e| format!("Invalid hex data '{}': {}", hex_data_str, e))?;
    if data.len() > 8 {
        return Err(format!(
            "Data length {} exceeds 8 bytes for classic CAN",
            data.len()
        ));
    }

    let gs = channel_options(bus, address, serial, bitrate, channel, can_clock);
    let task = open(gs, false).await?;

    println!(
        "Sending frame: ID=0x{:X}{}, DLC={}, data={}",
        can_id,
        if extended { " (EXT)" } else { "" },
        data.len(),
        hex::encode_upper(&data),
    );
    let frame = CanFrame::data(channel, can_id, extended, false, false, data);
    let sent = task.writer().send(frame).await;
    task.stop().await;
    println!("Device stopped.");

    match sent {
        Ok(Ok(())) => {
            println!("Frame sent successfully.");
            Ok(())
        }
        Ok(Err(e)) => Err(format!("Write failed: {}", e)),
        Err(refused) => Err(format!("Transmit refused: {}", refused)),
    }
}

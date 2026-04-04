// Subcommand implementations for gs_usb_cli.

use std::io::Write;
use std::time::Instant;

use wiretap_lib::io::gs_usb::nusb_driver::{
    encode_frame, initialize_device, list_devices, probe_device, stop_device,
};
use wiretap_lib::io::gs_usb::{
    can_feature, GsDeviceBtConst, GsHostFrame, GsUsbBreq, GsUsbConfig, GS_USB_ECHO_ID_RX,
};
use wiretap_lib::io::CanTransmitFrame;

use crate::usb_diag;

// ============================================================================
// list
// ============================================================================

pub fn cmd_list() -> Result<(), String> {
    let devices = list_devices()?;
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

pub fn cmd_probe(bus: u8, address: u8, serial: Option<&str>) -> Result<(), String> {
    let result = probe_device(bus, address, serial).map_err(|e| e.to_string())?;
    println!("Probe result for {}:{}", bus, address);
    println!("  Channels: {}", result.channel_count.unwrap_or(0));
    println!("  SW version: {}", result.sw_version.unwrap_or(0));
    println!("  HW version: {}", result.hw_version.unwrap_or(0));
    if let Some(clock) = result.can_clock {
        println!(
            "  CAN clock: {} Hz ({:.1} MHz)",
            clock,
            clock as f64 / 1_000_000.0
        );
    }
    if let Some(fd) = result.supports_fd {
        println!("  FD support: {}", fd);
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
// receive — the key diagnostic command
// ============================================================================

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
    // Find device
    let device_info = usb_diag::find_device(bus, address, serial)?;

    println!(
        "Opening device at {}:{} (serial: {})",
        device_info.bus_id(),
        device_info.device_address(),
        device_info.serial_number().unwrap_or("(none)")
    );

    // Open device once — use it for endpoint discovery AND streaming
    let device = device_info
        .open()
        .await
        .map_err(|e| format!("Failed to open device: {}", e))?;

    let endpoints = usb_diag::discover_endpoints_from_device(&device)?;
    println!(
        "Discovered endpoints: IN=0x{:02X}, OUT=0x{:02X}, max_pkt={}",
        endpoints.in_addr, endpoints.out_addr, endpoints.max_packet_size
    );

    let interface = device
        .claim_interface(0)
        .await
        .map_err(|e| format!("Failed to claim interface: {}", e))?;

    // Query BT_CONST to check pad support
    let bt_const_data = interface
        .control_in(
            nusb::transfer::ControlIn {
                control_type: nusb::transfer::ControlType::Vendor,
                recipient: nusb::transfer::Recipient::Interface,
                request: GsUsbBreq::BtConst as u8,
                value: channel as u16,
                index: 0,
                length: GsDeviceBtConst::SIZE as u16,
            },
            std::time::Duration::from_millis(1000),
        )
        .await
        .map_err(|e| format!("BT_CONST query failed: {:?}", e))?;

    let bt_const = GsDeviceBtConst::from_bytes(&bt_const_data);
    let pad_enabled = bt_const
        .map(|c| c.feature & can_feature::PAD_PKTS_TO_MAX_PKT_SIZE != 0)
        .unwrap_or(false);

    println!("PAD_PKTS_TO_MAX_PKT_SIZE: {}", pad_enabled);

    // Build config and initialize
    let config = GsUsbConfig {
        bus,
        address,
        serial: serial.map(|s| s.to_string()),
        bitrate,
        sample_point,
        listen_only,
        channel,
        limit: None,
        display_name: None,
        bus_override: None,
        enable_fd: false,
        data_bitrate: 2_000_000,
        data_sample_point: 75.0,
        can_clock_override: can_clock,
    };

    if let Some(clk) = can_clock {
        println!("CAN clock override: {} Hz", clk);
    }
    println!(
        "Initializing device (bitrate: {}, sample_point: {}%, listen_only: {})",
        bitrate, sample_point, listen_only
    );
    initialize_device(&interface, &config).await?;
    println!("Device initialized, starting receive loop");
    println!();

    // Open bulk IN endpoint using discovered address
    let mut bulk_in = interface
        .endpoint::<nusb::transfer::Bulk, nusb::transfer::In>(endpoints.in_addr)
        .map_err(|e| {
            format!(
                "Failed to open bulk IN endpoint 0x{:02X}: {}",
                endpoints.in_addr, e
            )
        })?;

    let buf_size: usize = endpoints.max_packet_size;

    // Pre-submit 4 read buffers
    for _ in 0..4 {
        bulk_in.submit(bulk_in.allocate(buf_size));
    }

    println!(
        "{:<6} {:<10} {:<12} {:<12} {:<4} {:<4} {:<4} {:<24} {:<10}",
        "#", "ACTUAL_LEN", "ECHO_ID", "CAN_ID", "CH", "DLC", "EXT", "DATA", "DELTA_MS"
    );
    println!("{}", "-".repeat(100));

    // Counters
    let mut completion_num: u64 = 0;
    let mut rx_frames: u64 = 0;
    let mut non_rx: u64 = 0;
    let mut errors: u64 = 0;
    let mut multi_frame_transfers: u64 = 0;
    let mut last_completion = Instant::now();
    let start_time = Instant::now();

    // Ctrl+C handling via tokio signal — no timeout wrapping
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    loop {
        // Check frame count limit
        if let Some(max) = count {
            if rx_frames >= max {
                println!("\nReached frame limit of {}", max);
                break;
            }
        }

        tokio::select! {
            _ = &mut ctrl_c => {
                println!("\n\nCtrl+C received");
                break;
            }
            completion = bulk_in.next_complete() => {
                let now = Instant::now();
                let delta_ms = now.duration_since(last_completion).as_secs_f64() * 1000.0;
                last_completion = now;
                completion_num += 1;

                match completion.status {
                    Ok(()) => {
                        let actual_len = completion.actual_len;
                        let data = &completion.buffer[..actual_len];

                        // Detect multi-frame transfers
                        let frame_size = GsHostFrame::SIZE;
                        let padded_size = endpoints.max_packet_size;
                        let frame_count = if pad_enabled && actual_len > padded_size {
                            multi_frame_transfers += 1;
                            actual_len / padded_size
                        } else if !pad_enabled && actual_len > frame_size && actual_len % frame_size == 0 {
                            multi_frame_transfers += 1;
                            actual_len / frame_size
                        } else {
                            1
                        };

                        if frame_count > 1 {
                            println!(
                                "  ** Multi-frame transfer: {} bytes = {} frames **",
                                actual_len, frame_count
                            );
                        }

                        // Parse each frame in the transfer
                        let stride = if frame_count > 1 && pad_enabled {
                            padded_size
                        } else if frame_count > 1 {
                            frame_size
                        } else {
                            actual_len
                        };

                        let mut offset = 0;
                        for _frame_idx in 0..frame_count {
                            if offset + 4 > actual_len {
                                break;
                            }

                            let end = actual_len.min(offset + stride);
                            let frame_data = &data[offset..end];
                            let frame_len = frame_data.len();

                            // Extract echo_id (first 4 bytes LE)
                            let echo_id = u32::from_le_bytes([
                                frame_data[0],
                                frame_data[1],
                                frame_data[2],
                                frame_data[3],
                            ]);

                            let is_rx = echo_id == GS_USB_ECHO_ID_RX;

                            if is_rx && frame_len >= GsHostFrame::SIZE {
                                rx_frames += 1;

                                if let Some(gs_frame) = GsHostFrame::from_bytes(frame_data) {
                                    let can_id = gs_frame.get_can_id();
                                    let ch = gs_frame.channel;
                                    let dlc = gs_frame.can_dlc;
                                    let is_ext = gs_frame.is_extended();
                                    let payload = gs_frame.get_data();
                                    let hex_data: String = payload
                                        .iter()
                                        .map(|b| format!("{:02X}", b))
                                        .collect::<Vec<_>>()
                                        .join(" ");

                                    println!(
                                        "{:<6} {:<10} 0x{:08X}   0x{:08X}   {:<4} {:<4} {:<4} {:<24} {:.3}",
                                        completion_num,
                                        actual_len,
                                        echo_id,
                                        can_id,
                                        ch,
                                        dlc,
                                        if is_ext { "EXT" } else { "STD" },
                                        hex_data,
                                        delta_ms,
                                    );
                                }
                            } else if !is_rx {
                                non_rx += 1;
                                let hex_dump: String = frame_data
                                    .iter()
                                    .take(20)
                                    .map(|b| format!("{:02X}", b))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                println!(
                                    "{:<6} {:<10} 0x{:08X}   [NON-RX] ch={} hex: {}  delta={:.3}ms",
                                    completion_num,
                                    actual_len,
                                    echo_id,
                                    if frame_len > 9 { frame_data[9] } else { 0 },
                                    hex_dump,
                                    delta_ms,
                                );
                            } else {
                                non_rx += 1;
                                println!(
                                    "{:<6} {:<10} [SHORT: {} bytes, need {}]  delta={:.3}ms",
                                    completion_num,
                                    actual_len,
                                    frame_len,
                                    GsHostFrame::SIZE,
                                    delta_ms,
                                );
                            }

                            offset += stride;
                        }

                        // Resubmit buffer
                        bulk_in.submit(bulk_in.allocate(buf_size));
                    }
                    Err(e) => {
                        errors += 1;
                        eprintln!(
                            "  #{} TRANSFER ERROR: {:?}  delta={:.3}ms",
                            completion_num, e, delta_ms
                        );
                        // Resubmit on error
                        bulk_in.submit(bulk_in.allocate(buf_size));
                    }
                }
            }
        }
    }

    // Final stats
    let elapsed = start_time.elapsed().as_secs_f64();
    println!("\n=== Final Statistics ===");
    println!("  Duration:              {:.1}s", elapsed);
    println!("  Total completions:     {}", completion_num);
    println!("  RX frames:             {}", rx_frames);
    println!("  Non-RX completions:    {}", non_rx);
    println!("  Transfer errors:       {}", errors);
    println!("  Multi-frame transfers: {}", multi_frame_transfers);
    if completion_num > 0 {
        println!(
            "  RX frame rate:         {:.1}%",
            rx_frames as f64 / completion_num as f64 * 100.0
        );
    }

    // Stop device
    let _ = stop_device(&interface, &config).await;
    println!("Device stopped.");

    Ok(())
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
    // Parse CAN ID
    let can_id = u32::from_str_radix(can_id_str, 16)
        .map_err(|e| format!("Invalid CAN ID '{}': {}", can_id_str, e))?;

    // Parse hex data
    let data = hex::decode(hex_data_str)
        .map_err(|e| format!("Invalid hex data '{}': {}", hex_data_str, e))?;

    if data.len() > 8 {
        return Err(format!(
            "Data length {} exceeds 8 bytes for classic CAN",
            data.len()
        ));
    }

    // Find device
    let device_info = usb_diag::find_device(bus, address, serial)?;

    println!(
        "Opening device at {}:{} (serial: {})",
        device_info.bus_id(),
        device_info.device_address(),
        device_info.serial_number().unwrap_or("(none)")
    );

    // Open device once
    let device = device_info
        .open()
        .await
        .map_err(|e| format!("Failed to open device: {}", e))?;

    let endpoints = usb_diag::discover_endpoints_from_device(&device)?;

    let interface = device
        .claim_interface(0)
        .await
        .map_err(|e| format!("Failed to claim interface: {}", e))?;

    // Build config and initialize (NOT listen-only for sending)
    let config = GsUsbConfig {
        bus,
        address,
        serial: serial.map(|s| s.to_string()),
        bitrate,
        sample_point: 87.5,
        listen_only: false,
        channel,
        limit: None,
        display_name: None,
        bus_override: None,
        enable_fd: false,
        data_bitrate: 2_000_000,
        data_sample_point: 75.0,
        can_clock_override: can_clock,
    };

    println!(
        "Initializing device (bitrate: {}, channel: {})",
        bitrate, channel
    );
    initialize_device(&interface, &config).await?;

    // Encode frame
    let frame = CanTransmitFrame {
        frame_id: can_id,
        data: data.clone(),
        bus: 0,
        is_extended: extended,
        is_fd: false,
        is_brs: false,
        is_rtr: false,
    };
    let encoded = encode_frame(&frame, channel);

    println!(
        "Sending frame: ID=0x{:X}{}, DLC={}, data={}",
        can_id,
        if extended { " (EXT)" } else { "" },
        data.len(),
        hex::encode(&data).to_uppercase(),
    );
    println!(
        "Encoded ({} bytes): {}",
        encoded.len(),
        hex::encode(&encoded).to_uppercase()
    );

    // Open bulk OUT endpoint
    let ep_out = interface
        .endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(endpoints.out_addr)
        .map_err(|e| {
            format!(
                "Failed to open bulk OUT endpoint 0x{:02X}: {}",
                endpoints.out_addr, e
            )
        })?;

    let mut writer = ep_out.writer(64);
    writer
        .write_all(&encoded)
        .map_err(|e| format!("Write failed: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Flush failed: {}", e))?;

    println!("Frame sent successfully.");

    // Stop device
    let _ = stop_device(&interface, &config).await;
    println!("Device stopped.");

    Ok(())
}

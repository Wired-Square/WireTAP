// crates/wiretap-app/src/io/gs_usb/nusb_driver.rs
//
// gs_usb on Windows and macOS: the passive probe and device list here, and the
// session's reader on wiretap-io's CAN task.

use nusb::transfer::{ControlIn, ControlType, Recipient};
use nusb::{Interface, MaybeFuture};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use wiretap_io::can::gsusb::{self, GsUsbDevice, GsUsbOptions};
use wiretap_io::can::{CanError, CanEvent, CanOptions};

use super::{can_feature, Breq, DeviceConfig, GsUsbDeviceInfo, GsUsbProbeResult, PIDS, VID};
use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{can_options, link_lost, mapped_frames, open_failed, serve};
use crate::io::error::IoError;
use crate::io::types::SourceMessage;

/// Timeout for USB control transfers
const CONTROL_TIMEOUT: Duration = Duration::from_millis(1000);

// ============================================================================
// Device Matching
// ============================================================================

/// Check if a USB device matches by serial number (preferred) or bus:address (fallback).
/// Returns true if:
/// - serial is Some and matches the device's serial number, OR
/// - serial is None and bus:address matches
pub fn device_matches(dev: &nusb::DeviceInfo, serial: Option<&str>, bus: u8, address: u8) -> bool {
    // Must be a gs_usb device
    if dev.vendor_id() != VID || !PIDS.contains(&dev.product_id()) {
        return false;
    }

    // Prefer serial number matching when available
    if let Some(target_serial) = serial {
        if let Some(dev_serial) = dev.serial_number() {
            return dev_serial == target_serial;
        }
    }

    // Fall back to bus:address matching
    let dev_bus = dev.bus_id().parse::<u8>().unwrap_or(0);
    dev_bus == bus && dev.device_address() == address
}

// ============================================================================
// Device Enumeration
// ============================================================================

/// List all gs_usb devices on the system
pub fn list_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    let devices = gsusb::devices().map_err(|e| format!("Failed to list USB devices: {}", e))?;
    Ok(devices
        .into_iter()
        .map(|dev| GsUsbDeviceInfo {
            bus: dev.bus,
            address: dev.address,
            product: dev.product,
            serial: dev.serial,
            interface_name: None,
            interface_up: None,
        })
        .collect())
}

/// Probe a specific gs_usb device to get its capabilities
pub fn probe_device(bus: u8, address: u8, serial: Option<&str>) -> Result<GsUsbProbeResult, IoError> {
    let device = format!("gs_usb({}:{})", bus, address);

    // Find the device using blocking .wait()
    // Prefer serial number matching (stable across re-enumeration) over bus:address
    let device_info = nusb::list_devices()
        .wait()
        .map_err(|e| IoError::other(&device, format!("list USB devices: {}", e)))?
        .find(|dev| device_matches(dev, serial, bus, address))
        .ok_or_else(|| IoError::not_found(&device))?;

    // Open the device (also returns MaybeFuture)
    let dev_handle = device_info
        .open()
        .wait()
        .map_err(|e| IoError::connection(&device, e.to_string()))?;

    // Claim interface 0 (also returns MaybeFuture)
    let interface = dev_handle
        .claim_interface(0)
        .wait()
        .map_err(|_| IoError::busy(&device))?;

    // Query device config (blocking via wait)
    let config = get_device_config_sync(&interface)
        .map_err(|e| IoError::protocol(&device, e))?;

    // Query BT_CONST to get feature flags and clock frequency
    let (can_clock, supports_fd) = get_bt_const_sync(&interface)
        .map(|(feature, fclk)| {
            let fd_supported = feature & can_feature::FD != 0;
            (Some(fclk), Some(fd_supported))
        })
        .unwrap_or((None, None));

    // icount is 0-indexed (number of interfaces - 1), so add 1 to get count
    Ok(GsUsbProbeResult {
        success: true,
        channel_count: Some(config.icount + 1),
        sw_version: Some(config.sw_version),
        hw_version: Some(config.hw_version),
        can_clock,
        supports_fd,
        error: None,
    })
}

/// Get bit timing constants (feature flags and clock) via USB control transfer (sync version)
fn get_bt_const_sync(interface: &Interface) -> Result<(u32, u32), String> {
    let data = interface
        .control_in(ControlIn {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: Breq::BtConst as u8,
            value: 0, // channel 0
            index: 0,
            length: 40,
        }, CONTROL_TIMEOUT)
        .wait()
        .map_err(|e| format!("BT_CONST query failed: {:?}", e))?;

    if data.len() >= 8 {
        let feature = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        let fclk = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        Ok((feature, fclk))
    } else {
        Err(format!(
            "Incomplete BT_CONST response: got {} bytes, expected at least 8",
            data.len()
        ))
    }
}

/// Get device configuration via USB control transfer (sync version)
fn get_device_config_sync(interface: &Interface) -> Result<DeviceConfig, String> {
    let data = interface
        .control_in(ControlIn {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: Breq::DeviceConfig as u8,
            value: 1,
            index: 0,
            length: DeviceConfig::SIZE as u16,
        }, CONTROL_TIMEOUT)
        .wait()
        .map_err(|e| format!("Control transfer failed: {:?}", e))?;

    DeviceConfig::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete response: got {} bytes, expected {}",
            data.len(),
            DeviceConfig::SIZE
        )
    })
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// The device hands back what it sent, which export and Test Pattern read as `tx`.
fn gs_usb_options(listen_only: bool) -> CanOptions {
    let mut options = can_options(listen_only, None);
    options.own_frames = true;
    options
}

/// A session maps a gs_usb source as one bus, and the device numbers it by its
/// channel, so transmits reach that channel and its reads are mapped.
fn on_channel(mappings: Vec<BusMapping>, channel: u8) -> Vec<BusMapping> {
    mappings
        .into_iter()
        .map(|mapping| BusMapping {
            device_bus: channel,
            ..mapping
        })
        .collect()
}

/// What the broker is told of `event`, or the loss that ends the source.
fn on_event(
    source_idx: usize,
    address: &str,
    channel: u8,
    mappings: &[BusMapping],
    event: CanEvent,
) -> Result<Vec<SourceMessage>, CanError> {
    match event {
        CanEvent::Connected(info) => {
            tlog!(
                "[gs_usb] Source {} connected to {} channel {} (channels: {:?}, fd: {})",
                source_idx,
                address,
                channel,
                info.buses,
                info.fd
            );
            Ok(vec![SourceMessage::Connected(
                source_idx,
                "gs_usb".to_string(),
                address.to_string(),
                Some(channel),
            )])
        }
        CanEvent::Read(reads) => Ok(mapped_frames(source_idx, reads, mappings)
            .into_iter()
            .collect()),
        CanEvent::Disconnected { error, .. } => Err(error),
    }
}

/// Run a gs_usb source on the library's CAN task, one channel per source.
#[allow(clippy::too_many_arguments)]
pub async fn run_source(
    source_idx: usize,
    bus: u8,
    address: u8,
    serial: Option<String>,
    bitrate: u32,
    sample_point: f32,
    listen_only: bool,
    channel: u8,
    enable_fd: bool,
    data_bitrate: u32,
    data_sample_point: f32,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = format!("gs_usb({}:{})", bus, address);
    let usb = GsUsbDevice {
        serial,
        bus,
        address,
        product: String::new(),
    };
    let mut gs = GsUsbOptions::new(usb, bitrate);
    gs.channel = channel;
    gs.sample_point = Some(sample_point);
    gs.data = enable_fd.then_some((data_bitrate, Some(data_sample_point)));

    let task = match gsusb::open(gs, gs_usb_options(listen_only)).await {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, open_failed(&device, e)))
                .await;
            return;
        }
    };

    let mappings = on_channel(bus_mappings, channel);
    let _ = tx
        .send(SourceMessage::MappingsResolved(
            source_idx,
            mappings.clone(),
        ))
        .await;
    let address = format!("{}:{}", bus, address);
    serve(
        task,
        source_idx,
        listen_only,
        &stop_flag,
        &tx,
        |event| on_event(source_idx, &address, channel, &mappings, event),
        |error| link_lost(source_idx, &device, error),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;
    use wiretap_io::can::{CanFrame, CanRead, DeviceInfo, Direction};

    use crate::io::can_task::can_frame;
    use crate::io::types::EndReason;
    use crate::io::CanTransmitFrame;

    const DEVICE: &str = "gs_usb(0:5)";

    fn session_bus(output_bus: u8) -> Vec<BusMapping> {
        vec![BusMapping {
            device_bus: 0,
            output_bus,
            ..BusMapping::default()
        }]
    }

    fn read(frame: CanFrame, direction: Direction) -> CanRead {
        CanRead {
            frame,
            direction,
            at: UNIX_EPOCH + Duration::from_micros(1_000),
            device_us: Some(1_000),
        }
    }

    #[test]
    fn a_connect_is_announced_on_its_channel() {
        let info = CanEvent::Connected(DeviceInfo::default());
        let messages = on_event(3, "0:5", 1, &[], info).unwrap();
        let [SourceMessage::Connected(3, kind, address, Some(1))] = messages.as_slice() else {
            panic!("expected Connected alone, on channel 1");
        };
        assert_eq!((kind.as_str(), address.as_str()), ("gs_usb", "0:5"));
    }

    #[test]
    fn a_read_on_the_channel_lands_on_the_sessions_bus() {
        let mappings = on_channel(session_bus(4), 1);
        let reads = vec![read(
            CanFrame::data(1, 0x123, false, false, false, vec![1, 2]),
            Direction::Rx,
        )];
        let messages = on_event(3, "0:5", 1, &mappings, CanEvent::Read(reads)).unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        assert_eq!((frames[0].frame_id, frames[0].bus), (0x123, 4));
        assert_eq!(frames[0].timestamp_us, 1_000);
    }

    #[test]
    fn a_transmit_routed_to_the_source_goes_out_on_its_channel() {
        let route = &on_channel(session_bus(4), 1)[0];
        let routed = CanTransmitFrame {
            frame_id: 0x7DF,
            data: vec![2, 1, 0],
            bus: route.device_bus,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };
        assert_eq!(can_frame(&routed).bus, 1);
    }

    #[test]
    fn an_echo_the_device_hands_back_stays_tx() {
        let reads = vec![
            read(
                CanFrame::data(0, 0x10, false, false, false, vec![]),
                Direction::Rx,
            ),
            read(
                CanFrame::data(0, 0x20, false, false, false, vec![]),
                Direction::Tx,
            ),
        ];
        let messages = on_event(3, "0:5", 0, &session_bus(0), CanEvent::Read(reads)).unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        let directions: Vec<_> = frames.iter().map(|f| f.direction.as_deref()).collect();
        assert_eq!(directions, [None, Some("tx")]);
    }

    #[test]
    fn echoes_are_asked_for_and_listen_only_reaches_the_device() {
        let options = gs_usb_options(true);
        assert!(options.own_frames && options.listen_only);
        assert_eq!(options.reopen, None);
        assert!(!gs_usb_options(false).listen_only);
    }

    #[test]
    fn an_unplug_ends_the_source_and_any_other_loss_is_an_error() {
        let lost = |error| {
            let event = CanEvent::Disconnected {
                error,
                consecutive: 1,
                retry_in: None,
            };
            let error = on_event(3, "0:5", 0, &[], event).err().expect("a loss");
            link_lost(3, DEVICE, error)
        };
        assert!(matches!(
            lost(CanError::Closed),
            SourceMessage::Ended(3, EndReason::Disconnected)
        ));
        let timed_out = std::io::Error::from(std::io::ErrorKind::TimedOut);
        let SourceMessage::Error(3, message) = lost(CanError::Read(timed_out)) else {
            panic!("expected an error");
        };
        assert!(message.starts_with("gs_usb(0:5): "), "got: {message}");
    }
}

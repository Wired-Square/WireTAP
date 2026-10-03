// crates/wiretap-app/src/io/gs_usb/nusb_driver.rs
//
// gs_usb on Windows and macOS: the passive probe and device list here, and the
// session's reader on wiretap-io's CAN task.

use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::mpsc;
use wiretap_io::can::gsusb::{self, GsUsbDevice, GsUsbOptions};
use wiretap_io::can::{CanError, CanEvent, CanOptions, DeviceInfo};

use super::{GsUsbDeviceInfo, GsUsbProbeResult};
use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{
    can_options, link_lost, mapped_bus_state, mapped_frames, open_failed, serve, PROBE_TIMEOUT,
};
use crate::io::error::IoError;
use crate::io::types::SourceMessage;

// ============================================================================
// Device Enumeration
// ============================================================================

/// List all gs_usb devices on the system
pub fn list_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    let devices = gsusb::devices().map_err(|e| format!("Failed to list USB devices: {}", e))?;
    Ok(devices.into_iter().map(GsUsbDeviceInfo::from).collect())
}

/// Reads a device's channels, versions and clock without starting a channel.
pub async fn probe_device(
    bus: u8,
    address: u8,
    serial: Option<String>,
) -> Result<GsUsbProbeResult, String> {
    let device = format!("gs_usb({}:{})", bus, address);
    let usb = GsUsbDevice {
        serial,
        bus,
        address,
        product: String::new(),
    };
    match gsusb::probe(&usb, PROBE_TIMEOUT).await {
        Ok(info) => Ok(probe_result(info)),
        Err(CanError::Open { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            Err(IoError::not_found(&device).to_string())
        }
        Err(e) => Err(open_failed(&device, e)),
    }
}

/// `DeviceInfo` carries the versions as decimal text; a failed `BT_CONST` leaves
/// no clock, and then FD is unknown rather than absent.
fn probe_result(info: DeviceInfo) -> GsUsbProbeResult {
    GsUsbProbeResult {
        success: true,
        channel_count: info.buses,
        sw_version: info.firmware.and_then(|v| v.parse().ok()),
        hw_version: info.hardware.and_then(|v| v.parse().ok()),
        can_clock: info.clock_hz,
        supports_fd: info.clock_hz.map(|_| info.fd),
        error: None,
    }
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
        CanEvent::Bus(state) => Ok(mapped_bus_state(source_idx, state, mappings)
            .into_iter()
            .collect()),
        CanEvent::Disconnected { error, .. } => Err(error),
        _ => Ok(Vec::new()),
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
    use std::time::{Duration, UNIX_EPOCH};
    use wiretap_io::can::{BusState, CanFrame, CanRead, Direction, ErrorState};

    use crate::io::bus_status::BusErrorState;
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
        let mut read = CanRead::new(frame, direction, UNIX_EPOCH + Duration::from_micros(1_000));
        read.device_us = Some(1_000);
        read
    }

    fn probed(clock_hz: Option<u32>) -> DeviceInfo {
        let mut info = DeviceInfo::default();
        info.buses = Some(2);
        info.fd = true;
        info.firmware = Some("2".into());
        info.hardware = Some("1".into());
        info.clock_hz = clock_hz;
        info
    }

    #[test]
    fn a_probe_reports_the_channels_versions_and_clock() {
        let result = probe_result(probed(Some(80_000_000)));
        assert!(result.success);
        assert_eq!(result.channel_count, Some(2));
        assert_eq!((result.sw_version, result.hw_version), (Some(2), Some(1)));
        assert_eq!(result.can_clock, Some(80_000_000));
        assert_eq!(result.supports_fd, Some(true));
    }

    #[test]
    fn without_bt_const_fd_is_unknown() {
        let result = probe_result(probed(None));
        assert_eq!((result.can_clock, result.supports_fd), (None, None));
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
    fn bus_trouble_on_the_channel_lands_on_the_sessions_bus() {
        let mut state = BusState::active(1);
        state.state = ErrorState::Passive;
        state.no_ack = true;
        state.tx_dropped = 7;
        state.tx_errors = Some(136);
        let messages =
            on_event(3, "0:5", 1, &on_channel(session_bus(4), 1), CanEvent::Bus(state)).unwrap();
        let [SourceMessage::BusState(3, status, 7)] = messages.as_slice() else {
            panic!("expected one BusState with seven sends lost");
        };
        assert_eq!((status.bus, status.state, status.no_ack), (4, BusErrorState::Passive, true));
        assert_eq!((status.tx_errors, status.rx_errors), (Some(136), None));

        let mut muted = on_channel(session_bus(4), 1);
        muted[0].enabled = false;
        let silent = on_event(3, "0:5", 1, &muted, CanEvent::Bus(BusState::active(1))).unwrap();
        assert!(silent.is_empty(), "a muted bus reports nothing");
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

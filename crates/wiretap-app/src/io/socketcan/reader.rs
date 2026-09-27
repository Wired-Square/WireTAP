// ui/crates/wiretap-app/src/io/socketcan/reader.rs
//
// SocketCAN source for Linux native CAN interfaces.
// Used with CANable Pro (Candlelight firmware) or native CAN hardware.
//
// Requires the interface to be configured first:
//   sudo ip link set can0 up type can bitrate 500000

use std::sync::{atomic::AtomicBool, Arc};

use tokio::sync::mpsc;
use wiretap_io::can::socketcan::{open as open_socketcan, SocketCanOptions};
use wiretap_io::can::{CanError, CanEvent};

use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{can_options, link_lost, mapped_frames, open_failed, serve};
use crate::io::types::SourceMessage;

// ============================================================================
// Interface Configuration
// ============================================================================

/// Configure a SocketCAN interface using pkexec for privilege escalation.
/// This brings down the interface, sets the bitrate, and brings it back up.
/// If enable_fd is true, the interface is configured for CAN FD mode.
///
/// Returns Ok(()) on success, or an error message on failure.
fn configure_interface(
    interface: &str,
    bitrate: u32,
    enable_fd: bool,
    data_bitrate: Option<u32>,
) -> Result<(), String> {
    use std::process::Command;

    tlog!(
        "[socketcan] Configuring interface {} with bitrate {}{} using pkexec",
        interface,
        bitrate,
        if enable_fd {
            format!(" (FD mode, dbitrate: {:?})", data_bitrate)
        } else {
            String::new()
        }
    );

    // Build the shell command to configure the interface
    // We use a single pkexec call with sh -c to run all commands in sequence
    let mut script = format!(
        "ip link set {iface} down && ip link set {iface} type can bitrate {bitrate}",
        iface = interface,
        bitrate = bitrate
    );

    // Add FD configuration if enabled
    if enable_fd {
        script.push_str(" fd on");
        if let Some(dbitrate) = data_bitrate {
            script.push_str(&format!(" dbitrate {}", dbitrate));
        }
    }

    script.push_str(&format!(" && ip link set {} up", interface));

    let output = Command::new("pkexec")
        .args(["sh", "-c", &script])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "pkexec not found. Install polkit or configure the interface manually.".to_string()
            } else {
                format!("Failed to run pkexec: {}", e)
            }
        })?;

    if output.status.success() {
        tlog!(
            "[socketcan] Interface {} configured successfully",
            interface
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        // Check for common error cases
        if stderr.contains("dismissed") || stderr.contains("cancelled") {
            Err("Authentication cancelled by user".to_string())
        } else if stderr.contains("Not authorized") {
            Err("Not authorised to configure network interfaces".to_string())
        } else {
            let error_detail = if !stderr.is_empty() {
                stderr.trim().to_string()
            } else if !stdout.is_empty() {
                stdout.trim().to_string()
            } else {
                format!("Exit code: {:?}", output.status.code())
            };
            Err(format!("Failed to configure interface: {}", error_detail))
        }
    }
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// What the broker is told of `event`, or the loss that ends the source.
fn on_event(
    source_idx: usize,
    interface: &str,
    mappings: &[BusMapping],
    event: CanEvent,
) -> Result<Vec<SourceMessage>, CanError> {
    match event {
        CanEvent::Connected(info) => {
            tlog!(
                "[socketcan] Source {} connected to {} (fd: {})",
                source_idx,
                interface,
                info.fd
            );
            Ok(vec![SourceMessage::Connected(
                source_idx,
                "socketcan".to_string(),
                interface.to_string(),
                None,
            )])
        }
        CanEvent::Read(reads) => Ok(mapped_frames(source_idx, reads, mappings)
            .into_iter()
            .collect()),
        CanEvent::Disconnected { error, .. } => Err(error),
    }
}

/// Run a SocketCAN source on the library's CAN task.
///
/// If `bitrate` is provided, the interface is configured with pkexec before
/// the socket opens.
pub async fn run_source(
    source_idx: usize,
    interface: String,
    bitrate: Option<u32>,
    enable_fd: bool,
    data_bitrate: Option<u32>,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = format!("socketcan({})", interface);

    if let Some(br) = bitrate {
        if let Err(e) = configure_interface(&interface, br, enable_fd, data_bitrate) {
            let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
            return;
        }
    }

    // `enable_fd` only picks the bring-up; the interface decides whether FD
    // frames reach the socket.
    let options = SocketCanOptions {
        interface: interface.clone(),
        fd: true,
    };
    let task = match open_socketcan(options, can_options(false, None)).await {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, open_failed(&device, e)))
                .await;
            return;
        }
    };

    serve(
        task,
        source_idx,
        false,
        &stop_flag,
        &tx,
        |event| on_event(source_idx, &interface, &bus_mappings, event),
        |error| link_lost(source_idx, &device, error),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};
    use wiretap_io::can::{CanFrame, CanRead, DeviceInfo, Direction};

    use crate::io::can_task::can_frame;
    use crate::io::types::EndReason;
    use crate::io::CanTransmitFrame;

    fn mapping(enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus: 0,
            enabled,
            output_bus,
            ..BusMapping::default()
        }
    }

    fn read(frame: CanFrame, at_us: u64) -> CanRead {
        CanRead {
            frame,
            direction: Direction::Rx,
            at: UNIX_EPOCH + Duration::from_micros(at_us),
            device_us: None,
        }
    }

    #[test]
    fn a_connect_is_announced_as_socketcan_on_its_interface() {
        let messages =
            on_event(3, "can0", &[], CanEvent::Connected(DeviceInfo::default())).unwrap();
        let [SourceMessage::Connected(3, kind, interface, None)] = messages.as_slice() else {
            panic!("expected Connected alone");
        };
        assert_eq!((kind.as_str(), interface.as_str()), ("socketcan", "can0"));
    }

    #[test]
    fn one_read_is_one_frames_message_on_the_mapped_bus_at_the_kernel_time() {
        let reads = vec![
            read(
                CanFrame::data(0, 0x123, false, false, false, vec![1, 2]),
                1_000,
            ),
            read(
                CanFrame::data(0, 0x456, true, true, true, vec![3; 12]),
                1_250,
            ),
        ];
        let messages = on_event(3, "can0", &[mapping(true, 4)], CanEvent::Read(reads)).unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        let stamped: Vec<_> = frames
            .iter()
            .map(|f| (f.frame_id, f.bus, f.timestamp_us, f.is_fd))
            .collect();
        assert_eq!(stamped, [(0x123, 4, 1_000, false), (0x456, 4, 1_250, true)]);

        let muted = vec![read(
            CanFrame::data(0, 0x123, false, false, false, vec![]),
            0,
        )];
        let muted = on_event(3, "can0", &[mapping(false, 4)], CanEvent::Read(muted)).unwrap();
        assert!(muted.is_empty());
    }

    #[test]
    fn a_downed_interface_is_an_error_and_a_deleted_one_a_disconnect() {
        let lost = |error| {
            let error = on_event(
                3,
                "can0",
                &[],
                CanEvent::Disconnected {
                    error,
                    consecutive: 1,
                    retry_in: None,
                },
            )
            .err()
            .expect("a loss ends the source");
            link_lost(3, "socketcan(can0)", error)
        };
        let down = std::io::Error::from(std::io::ErrorKind::NetworkDown);
        let SourceMessage::Error(3, message) = lost(CanError::Read(down)) else {
            panic!("expected an error");
        };
        assert!(message.starts_with("socketcan(can0): "), "got: {message}");
        assert!(matches!(
            lost(CanError::Closed),
            SourceMessage::Ended(3, EndReason::Disconnected)
        ));
    }

    #[test]
    fn a_transmit_keeps_its_remote_request_and_bit_rate_switch() {
        let mut frame = CanTransmitFrame {
            frame_id: 0x18DA_F110,
            data: vec![0; 3],
            bus: 0,
            is_extended: true,
            is_fd: false,
            is_brs: false,
            is_rtr: true,
        };
        let remote = can_frame(&frame);
        assert!(remote.rtr && remote.extended);
        assert_eq!(remote.dlc(), 3);

        frame.is_rtr = false;
        frame.is_fd = true;
        frame.is_brs = true;
        frame.data = vec![7; 12];
        let fd = can_frame(&frame);
        assert!(fd.fd && fd.brs && !fd.rtr);
        assert_eq!(fd.dlc(), 9);
    }
}

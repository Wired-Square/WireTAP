// crates/wiretap-app/src/io/can_task.rs
//
// The desktop's side of a `wiretap_io::can` task: its reads become
// `FrameMessage`s, and the session's transmits reach its `CanWriter`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Weak};
use std::time::{Duration, UNIX_EPOCH};

use tokio::sync::mpsc;
use wiretap_io::can::{
    CanError, CanEvent, CanFrame, CanOptions, CanRead, CanTask, CanWriter, Direction, SendRefused,
};

use crate::io::bus_mapping::{apply_bus_mappings_batch, BusMapping};
#[cfg(not(target_os = "ios"))]
use crate::io::error::DevicePresence;
use crate::io::error::IoError;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use crate::io::{CanTransmitFrame, FrameMessage};

const STOP_POLL: Duration = Duration::from_millis(50);

/// The session, not the task, decides what a lost device means, so it never reopens.
pub(crate) fn can_options(listen_only: bool) -> CanOptions {
    let mut options = CanOptions::default();
    options.listen_only = listen_only;
    options.reopen = None;
    options
}

pub(crate) fn frame_message(read: CanRead) -> FrameMessage {
    let CanRead {
        frame,
        direction,
        at,
        ..
    } = read;
    FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: at
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as u64),
        frame_id: frame.arb_id,
        bus: frame.bus,
        dlc: frame.data.len() as u8,
        is_fd: frame.fd,
        is_extended: frame.extended,
        bytes: frame.data,
        source_address: None,
        incomplete: None,
        direction: (direction == Direction::Tx).then(|| "tx".to_string()),
    }
}

pub(crate) fn can_frame(frame: &CanTransmitFrame) -> CanFrame {
    if frame.is_rtr {
        CanFrame::remote(
            frame.bus,
            frame.frame_id,
            frame.is_extended,
            frame.data.len() as u8,
        )
    } else {
        CanFrame::data(
            frame.bus,
            frame.frame_id,
            frame.is_extended,
            frame.is_fd,
            frame.is_brs,
            frame.data.clone(),
        )
    }
}

fn transmit_result(sent: Result<std::io::Result<()>, SendRefused>) -> Result<(), String> {
    match sent {
        Ok(written) => written.map_err(|e| format!("Write error: {e}")),
        Err(refused) => Err(format!("Transmit refused: {refused}")),
    }
}

/// One `Frames` for a read, on the session's buses; none when every frame in it
/// was on a muted bus.
pub(crate) fn mapped_frames(
    source_idx: usize,
    reads: Vec<CanRead>,
    mappings: &[BusMapping],
) -> Option<SourceMessage> {
    let frames = apply_bus_mappings_batch(reads.into_iter().map(frame_message).collect(), mappings);
    (!frames.is_empty()).then(|| SourceMessage::Frames(source_idx, frames))
}

pub(crate) fn open_failed(device: &str, error: CanError) -> String {
    match error {
        CanError::Open { source, .. } => {
            IoError::connection(device, source.to_string()).to_string()
        }
        other => format!("{device}: {other}"),
    }
}

/// A closed link ends the source as disconnected; any other loss, an
/// unanswered keepalive included, is an error.
pub(crate) fn link_lost(source_idx: usize, device: &str, error: CanError) -> SourceMessage {
    match error {
        CanError::Closed => SourceMessage::Ended(source_idx, EndReason::Disconnected),
        other => SourceMessage::Error(source_idx, format!("{device}: {other}")),
    }
}

/// On a serial port a read error is worded by whether the port is still there:
/// in use by something else, or unplugged.
#[cfg(not(target_os = "ios"))]
pub(crate) fn port_lost(
    source_idx: usize,
    device: &str,
    port: &str,
    error: CanError,
    presence: impl FnOnce(&str) -> DevicePresence,
) -> SourceMessage {
    match error {
        CanError::Read(e) => SourceMessage::Error(
            source_idx,
            IoError::device_stream_error_message(port, &e, presence(port)),
        ),
        other => link_lost(source_idx, device, other),
    }
}

/// Serve `task` to the session until `lost` words its loss, or `stop_flag`
/// stops it. A listen-only source is offered no transmit.
pub(crate) async fn serve(
    mut task: CanTask,
    source_idx: usize,
    listen_only: bool,
    stop_flag: &AtomicBool,
    tx: &mpsc::Sender<SourceMessage>,
    mut on_event: impl FnMut(CanEvent) -> Result<Vec<SourceMessage>, CanError>,
    lost: impl FnOnce(CanError) -> SourceMessage,
) {
    let reader_running = Arc::new(());
    if !listen_only {
        let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
        forward_transmits(transmit_rx, task.writer(), Arc::downgrade(&reader_running));
        let _ = tx
            .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
            .await;
    }
    let mut poll = tokio::time::interval(STOP_POLL);
    let ended = loop {
        tokio::select! {
            event = task.next_event() => {
                let Some(event) = event else { break lost(CanError::Closed) };
                match on_event(event) {
                    Ok(messages) => {
                        for message in messages {
                            let _ = tx.send(message).await;
                        }
                    }
                    Err(error) => break lost(error),
                }
            }
            _ = poll.tick() => {
                if stop_flag.load(Ordering::SeqCst) {
                    task.stop().await;
                    break SourceMessage::Ended(source_idx, EndReason::Stopped);
                }
            }
        }
    };
    let _ = tx.send(ended).await;
}

/// `TransmitSender` is a std channel, so its requests reach the async writer
/// from a blocking thread, which ends once the reader has.
fn forward_transmits(
    requests: std_mpsc::Receiver<TransmitRequest>,
    writer: CanWriter,
    reader: Weak<()>,
) {
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || loop {
        match requests.recv_timeout(Duration::from_millis(50)) {
            Ok(req) => {
                let result = match req.frame {
                    Some(frame) => transmit_result(runtime.block_on(writer.send(frame))),
                    None => Err("Transmit refused: no CAN frame to send".to_string()),
                };
                if let Err(e) = &result {
                    tlog!("[can] Transmit failed: {}", e);
                }
                let _ = req.result_tx.send(result);
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) if reader.strong_count() > 0 => {}
            Err(_) => return,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_io::can::Unsupported;

    fn read(frame: CanFrame, direction: Direction, at_us: u64) -> CanRead {
        CanRead {
            frame,
            direction,
            at: UNIX_EPOCH + Duration::from_micros(at_us),
            device_us: Some(42),
        }
    }

    #[test]
    fn a_read_is_stamped_with_its_own_time_and_counts_its_bytes() {
        let f = frame_message(read(
            CanFrame::data(1, 0x1234_5678, true, true, true, vec![7; 12]),
            Direction::Rx,
            1_700_000_000_123_456,
        ));
        assert_eq!(f.timestamp_us, 1_700_000_000_123_456);
        assert_eq!((f.frame_id, f.bus, f.dlc), (0x1234_5678, 1, 12));
        assert!(f.is_extended && f.is_fd);
        assert_eq!(f.direction, None);
        assert_eq!(f.protocol, "can");
    }

    #[test]
    fn an_own_frame_handed_back_reads_as_tx() {
        let f = frame_message(read(
            CanFrame::data(0, 1, false, false, false, vec![]),
            Direction::Tx,
            0,
        ));
        assert_eq!(f.direction.as_deref(), Some("tx"));
    }

    #[test]
    fn a_transmit_keeps_its_flags_and_a_remote_one_its_length_code() {
        let mut tx = CanTransmitFrame {
            frame_id: 0x321,
            data: vec![1, 2, 3],
            bus: 2,
            is_extended: false,
            is_fd: true,
            is_brs: true,
            is_rtr: false,
        };
        assert_eq!(
            can_frame(&tx),
            CanFrame::data(2, 0x321, false, true, true, vec![1, 2, 3])
        );
        tx.is_rtr = true;
        let remote = can_frame(&tx);
        assert!(remote.rtr && remote.data.is_empty());
        assert_eq!(remote.dlc(), 3);
    }

    #[test]
    fn a_refused_or_failed_transmit_says_which() {
        assert_eq!(transmit_result(Ok(Ok(()))), Ok(()));
        let refused = transmit_result(Err(SendRefused::Unsupported(Unsupported::Length(12))));
        assert_eq!(
            refused,
            Err("Transmit refused: 12 bytes is too long".into())
        );
        let failed = transmit_result(Ok(Err(std::io::Error::other("broken pipe"))));
        assert_eq!(failed, Err("Write error: broken pipe".into()));
    }

    const DEVICE: &str = "gvret_usb(/dev/cu.usbmodem1)";
    const PORT: &str = "/dev/cu.usbmodem1";

    #[test]
    fn a_closed_link_is_a_disconnect_and_any_other_loss_an_error() {
        assert!(matches!(
            link_lost(3, DEVICE, CanError::Closed),
            SourceMessage::Ended(3, EndReason::Disconnected)
        ));
        let SourceMessage::Error(3, unresponsive) = link_lost(3, DEVICE, CanError::Unresponsive)
        else {
            panic!("expected an error");
        };
        assert_eq!(unresponsive, format!("{DEVICE}: device stopped answering"));
        let SourceMessage::Error(3, read) = link_lost(
            3,
            DEVICE,
            CanError::Read(std::io::Error::other("connection reset")),
        ) else {
            panic!("expected an error");
        };
        assert!(read.contains("connection reset"), "got: {read}");
    }

    #[cfg(not(target_os = "ios"))]
    fn port_read_failed(presence: DevicePresence) -> String {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        match port_lost(3, DEVICE, PORT, CanError::Read(denied), |port| {
            assert_eq!(port, PORT, "the port is what is probed");
            presence
        }) {
            SourceMessage::Error(3, message) => message,
            _ => panic!("expected an error"),
        }
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn a_port_read_error_says_whether_the_port_is_in_use_or_gone() {
        assert!(port_read_failed(DevicePresence::Present).contains("in use"));
        assert!(port_read_failed(DevicePresence::Absent).contains("unplugged"));
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn a_closed_port_is_a_disconnect_without_a_probe() {
        let ended = port_lost(3, DEVICE, PORT, CanError::Closed, |_| {
            panic!("a close needs no probe")
        });
        assert!(matches!(
            ended,
            SourceMessage::Ended(3, EndReason::Disconnected)
        ));
    }

    #[test]
    fn a_port_that_will_not_open_names_the_device() {
        let failed = open_failed(
            DEVICE,
            CanError::Open {
                device: PORT.into(),
                source: std::io::Error::from(std::io::ErrorKind::NotFound),
            },
        );
        assert!(
            failed.starts_with(&format!("[{DEVICE}] connection failed")),
            "got: {failed}"
        );
    }
}

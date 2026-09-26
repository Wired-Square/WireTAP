// crates/wiretap-app/src/io/can_task.rs
//
// The desktop's side of a `wiretap_io::can` task: its reads become
// `FrameMessage`s, and the session's transmits reach its `CanWriter`.

use std::sync::{mpsc as std_mpsc, Weak};
use std::time::{Duration, UNIX_EPOCH};

use wiretap_io::can::{CanFrame, CanRead, CanWriter, Direction, SendRefused};

use crate::io::types::TransmitRequest;
use crate::io::{CanTransmitFrame, FrameMessage};

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

/// `TransmitSender` is a std channel, so its requests reach the async writer
/// from a blocking thread, which ends once the reader has.
pub(crate) fn forward_transmits(
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
}

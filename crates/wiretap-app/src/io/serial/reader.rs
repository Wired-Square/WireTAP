// ui/crates/wiretap-app/src/io/serial/reader.rs
//
// Serial port reader for multi-source sessions.
// Can emit raw bytes and/or framed messages (SLIP, Modbus RTU, delimiter-based).
// Provides cross-platform serial communication for WireTAP.

use serde::Serialize;
use std::sync::mpsc as std_mpsc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Weak,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use wiretap_catalog::{RtuTap, TappedMessage};
use wiretap_io::serial::{
    self, Access, LineSettings, SerialError, SerialEvent, SerialOptions, SerialWriter, WriteRefused,
};

use crate::io::bus_mapping::{apply_bus_mapping, BusMapping};
use crate::io::error::{DevicePresence, IoError};
use crate::io::types::{ByteEntry, EndReason, SetFramingRequest, SourceMessage, TransmitRequest};
use crate::io::FrameMessage;

// Re-export Parity for external use
use super::framer::{
    extract_frame_id, residue, rtu_frame, FrameIdConfig, FramingEncoding, SerialFrame, SerialFramer,
};
pub use super::utils::Parity;
use super::utils::{framing_from_str, probe_serial_presence, SerialSourceConfig};

/// How often the read loop looks at the stop flag and for a framing change.
const POLL: Duration = Duration::from_millis(50);

// ============================================================================
// Types
// ============================================================================

/// Information about an available serial port
#[derive(Clone, Serialize)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

fn micros(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

fn stamped(frames: Vec<SerialFrame>, at: SystemTime) -> Vec<(SerialFrame, u64)> {
    let timestamp_us = micros(at);
    frames.into_iter().map(|f| (f, timestamp_us)).collect()
}

fn tapped(tapped: TappedMessage) -> (SerialFrame, u64) {
    (rtu_frame(tapped.message), micros(tapped.at))
}

enum Framer {
    Unframed,
    Serial(SerialFramer),
    /// Stamps each message at its last byte, rather than at the read that
    /// released it.
    Rtu(RtuTap),
}

impl Framer {
    fn new(encoding: FramingEncoding, line: LineSettings) -> Self {
        match encoding {
            FramingEncoding::Raw => Self::Unframed,
            FramingEncoding::ModbusRtu(options) => Self::Rtu(RtuTap::new(&(&options).into(), line)),
            encoding => Self::Serial(SerialFramer::new(encoding)),
        }
    }

    fn feed(&mut self, bytes: &[u8], at: SystemTime) -> Vec<(SerialFrame, u64)> {
        match self {
            Self::Unframed => Vec::new(),
            Self::Serial(framer) => stamped(framer.feed(bytes), at),
            Self::Rtu(tap) => tap.push(bytes, at).into_iter().map(tapped).collect(),
        }
    }

    /// End of stream. Modbus RTU can still recover whole messages from what it
    /// holds, so this is a list, not one residue.
    fn finish(&mut self, now: SystemTime) -> Vec<(SerialFrame, u64)> {
        match self {
            Self::Unframed => Vec::new(),
            Self::Serial(framer) => stamped(framer.flush(), now),
            Self::Rtu(tap) => {
                let (messages, trailing) = tap.finish();
                let leftover = stamped(residue(trailing), now);
                messages.into_iter().map(tapped).chain(leftover).collect()
            }
        }
    }
}

/// What a live serial source makes of each read, with the framing a
/// `SetFraming` request swaps in place.
struct LiveLine {
    source_idx: usize,
    line: LineSettings,
    output_bus: u8,
    bus_mappings: Vec<BusMapping>,
    framer: Framer,
    frame_id_config: Option<FrameIdConfig>,
    source_address_config: Option<FrameIdConfig>,
    min_frame_length: usize,
    emit_raw_bytes: bool,
    /// No byte is stamped before one already handed out, as `RtuTap`'s floor.
    byte_floor_us: u64,
}

impl LiveLine {
    fn new(source_idx: usize, config: SerialSourceConfig, bus_mappings: Vec<BusMapping>) -> Self {
        let output_bus = bus_mappings
            .iter()
            .find(|m| m.enabled)
            .map(|m| m.output_bus)
            .unwrap_or(0);
        Self {
            source_idx,
            line: config.line,
            output_bus,
            bus_mappings,
            framer: Framer::new(config.framing_encoding, config.line),
            frame_id_config: config.frame_id_config,
            source_address_config: config.source_address_config,
            min_frame_length: config.min_frame_length,
            emit_raw_bytes: config.emit_raw_bytes,
            byte_floor_us: 0,
        }
    }

    fn read(&mut self, bytes: &[u8], at: SystemTime) -> Vec<SourceMessage> {
        let mut messages = Vec::new();
        if self.emit_raw_bytes {
            messages.push(SourceMessage::Bytes(
                self.source_idx,
                self.byte_entries(bytes, at),
            ));
        }
        let frames = self.framer.feed(bytes, at);
        messages.extend(self.frames(frames));
        messages
    }

    fn finish(&mut self) -> Option<SourceMessage> {
        let frames = self.framer.finish(SystemTime::now());
        self.frames(frames)
    }

    /// Byte `i` of an `n`-byte read arrived `wire_time(n - 1 - i)` before the
    /// read returned.
    fn byte_entries(&mut self, bytes: &[u8], at: SystemTime) -> Vec<ByteEntry> {
        let at_us = micros(at);
        let last = bytes.len().saturating_sub(1);
        bytes
            .iter()
            .enumerate()
            .map(|(i, &byte)| {
                let behind = self.line.wire_time((last - i) as u64).as_micros() as u64;
                self.byte_floor_us = at_us.saturating_sub(behind).max(self.byte_floor_us);
                ByteEntry {
                    byte,
                    timestamp_us: self.byte_floor_us,
                    bus: self.output_bus,
                }
            })
            .collect()
    }

    /// Too-short frames, and any the bus mapping drops, are left out.
    fn frames(&self, frames: Vec<(SerialFrame, u64)>) -> Option<SourceMessage> {
        let frames: Vec<FrameMessage> = frames
            .into_iter()
            .filter(|(f, _)| f.bytes.len() >= self.min_frame_length)
            .filter_map(|(frame, timestamp_us)| {
                let extract = |cfg: Option<&FrameIdConfig>| {
                    cfg.and_then(|c| extract_frame_id(&frame.bytes, c))
                };
                let frame_id = extract(self.frame_id_config.as_ref()).unwrap_or(0);
                let source_address = extract(self.source_address_config.as_ref()).map(|v| v as u16);

                // `frame.crc_valid` is deliberately not carried: the decode path
                // recomputes it from these same bytes. See `framing.rs`.
                let mut msg = FrameMessage {
                    protocol: "serial".to_string(),
                    timestamp_us,
                    frame_id,
                    bus: 0,
                    dlc: frame.bytes.len() as u8,
                    bytes: frame.bytes,
                    is_extended: false,
                    is_fd: false,
                    source_address,
                    incomplete: frame.incomplete.then_some(true),
                    direction: None,
                };
                apply_bus_mapping(&mut msg, &self.bus_mappings).then_some(msg)
            })
            .collect();
        (!frames.is_empty()).then(|| SourceMessage::Frames(self.source_idx, frames))
    }

    /// The old framer's partial buffer is dropped; the device re-syncs on the
    /// next boundary in the new encoding.
    fn set_framing(&mut self, req: SetFramingRequest) {
        self.framer = Framer::new(
            framing_from_str(&req.encoding, req.modbus.as_ref()),
            self.line,
        );
        let extraction = |start: Option<i32>, bytes: Option<u8>, big_endian: bool| {
            start.map(|start_byte| FrameIdConfig {
                start_byte,
                num_bytes: bytes.unwrap_or(1),
                big_endian,
            })
        };
        self.frame_id_config = extraction(
            req.frame_id_start_byte,
            req.frame_id_bytes,
            req.frame_id_big_endian,
        );
        self.source_address_config = extraction(
            req.source_address_start_byte,
            req.source_address_bytes,
            req.source_address_big_endian,
        );
        self.min_frame_length = req.min_frame_length;
        self.emit_raw_bytes = req.emit_raw_bytes;
        tlog!(
            "[serial] Source {} framing updated → {}",
            self.source_idx,
            req.encoding
        );
    }
}

/// A zero-byte read is the device going away; any other read error is told
/// apart as "in use" or "gone" by whether the port still enumerates.
fn line_lost(
    source_idx: usize,
    port: &str,
    error: SerialError,
    presence: impl FnOnce(&str) -> DevicePresence,
) -> SourceMessage {
    match error {
        SerialError::Closed => SourceMessage::Ended(source_idx, EndReason::Disconnected),
        SerialError::Read(e) => SourceMessage::Error(
            source_idx,
            IoError::device_stream_error_message(port, &e, presence(port)),
        ),
        other => SourceMessage::Error(source_idx, format!("{port}: {other}")),
    }
}

fn transmit_result(written: Result<std::io::Result<()>, WriteRefused>) -> Result<(), String> {
    match written {
        Ok(written) => written.map_err(|e| format!("Write error: {}", e)),
        Err(refused) => Err(format!("Write refused: {}", refused)),
    }
}

/// `TransmitSender` is a std channel, so its requests reach the async writer
/// from a blocking thread, which ends once the reader has.
fn forward_transmits(
    requests: std_mpsc::Receiver<TransmitRequest>,
    writer: SerialWriter,
    reader: Weak<()>,
) {
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || loop {
        match requests.recv_timeout(POLL) {
            Ok(req) => {
                let result = transmit_result(runtime.block_on(writer.write(req.data)));
                if let Err(e) = &result {
                    tlog!("[serial] Transmit failed: {}", e);
                }
                let _ = req.result_tx.send(result);
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) if reader.strong_count() > 0 => {}
            Err(_) => return,
        }
    });
}

/// Run serial source and send frames/bytes to merge task.
/// Can emit raw bytes and/or framed data depending on configuration.
pub async fn run_source(
    source_idx: usize,
    config: SerialSourceConfig,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let port = config.port.clone();
    let options = SerialOptions {
        access: Access::ReadWrite,
        read_buffer: 256,
        reopen: None,
        ..SerialOptions::default()
    };
    let mut task = match serial::open(&port, config.line, options) {
        Ok(task) => task,
        Err(e) => {
            let reason = match e {
                SerialError::Open { source, .. } => source.to_string(),
                e => e.to_string(),
            };
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to open {}: {}", port, reason),
                ))
                .await;
            return;
        }
    };

    let reader_running = Arc::new(());
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    forward_transmits(transmit_rx, task.writer(), Arc::downgrade(&reader_running));
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    let (control_tx, control_rx) = std_mpsc::sync_channel::<SetFramingRequest>(8);
    let _ = tx
        .send(SourceMessage::ControlReady(source_idx, control_tx))
        .await;

    tlog!(
        "[serial] Source {} connected to {} (baud: {}, framing: {:?}, emit_raw: {})",
        source_idx,
        port,
        config.line.baud,
        config.framing_encoding,
        config.emit_raw_bytes
    );
    let mut live = LiveLine::new(source_idx, config, bus_mappings);

    let mut poll = tokio::time::interval(POLL);
    let lost = loop {
        tokio::select! {
            event = task.next_event() => match event {
                Some(SerialEvent::Connected) => {
                    let connected = SourceMessage::Connected(
                        source_idx,
                        "serial".to_string(),
                        port.clone(),
                        Some(live.output_bus),
                    );
                    let _ = tx.send(connected).await;
                }
                Some(SerialEvent::Read { bytes, at }) => {
                    for message in live.read(&bytes, at) {
                        let _ = tx.send(message).await;
                    }
                }
                Some(SerialEvent::Disconnected { error, .. }) => break Some(error),
                None => break Some(SerialError::Closed),
            },
            _ = poll.tick() => {
                if stop_flag.load(Ordering::SeqCst) {
                    break None;
                }
                while let Ok(req) = control_rx.try_recv() {
                    live.set_framing(req);
                }
            }
        }
    };

    let ended = match lost {
        Some(error) => line_lost(source_idx, &port, error, probe_serial_presence),
        None => {
            task.stop().await;
            if let Some(flushed) = live.finish() {
                let _ = tx.send(flushed).await;
            }
            SourceMessage::Ended(source_idx, EndReason::Stopped)
        }
    };
    let _ = tx.send(ended).await;
}
// ============================================================================
// Tauri Commands
// ============================================================================

/// List available serial ports
///
/// On macOS, filters out /dev/tty.* devices and only shows /dev/cu.* devices.
/// The cu (calling unit) devices are non-blocking and preferred for outgoing connections.
/// The tty (terminal) devices block on open waiting for carrier detect.
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("Failed to enumerate ports: {}", e))?;

    Ok(ports
        .into_iter()
        // On macOS, filter out /dev/tty.* devices - only show /dev/cu.* (calling unit)
        .filter(|_p| {
            #[cfg(target_os = "macos")]
            {
                !_p.port_name.starts_with("/dev/tty.")
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        })
        .map(|p| {
            let (port_type, manufacturer, product, serial_number, vid, pid) = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    "USB".to_string(),
                    info.manufacturer,
                    info.product,
                    info.serial_number,
                    Some(info.vid),
                    Some(info.pid),
                ),
                serialport::SerialPortType::BluetoothPort => {
                    ("Bluetooth".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::PciPort => {
                    ("PCI".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::Unknown => {
                    ("Unknown".to_string(), None, None, None, None, None)
                }
            };
            SerialPortInfo {
                port_name: p.port_name,
                port_type,
                manufacturer,
                product,
                serial_number,
                vid,
                pid,
            }
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::types::ModbusRtuOptions;
    use wiretap_io::serial::Parity as LineParity;

    const LINE_9600_8N1: LineSettings = LineSettings {
        baud: 9600,
        data_bits: 8,
        parity: LineParity::None,
        stop_bits: 1,
    };

    fn at(us: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_micros(us)
    }

    fn live(framing_encoding: FramingEncoding, emit_raw_bytes: bool) -> LiveLine {
        let config = SerialSourceConfig {
            port: "/dev/test".to_string(),
            line: LINE_9600_8N1,
            framing_encoding,
            frame_id_config: None,
            source_address_config: None,
            min_frame_length: 0,
            emit_raw_bytes,
        };
        LiveLine::new(0, config, Vec::new())
    }

    fn rtu(body: &[u8]) -> Vec<u8> {
        let mut out = body.to_vec();
        out.extend(wiretap_checksum::algorithms::crc16_modbus_checksum(body).to_le_bytes());
        out
    }

    fn frames(messages: Vec<SourceMessage>) -> Vec<FrameMessage> {
        messages
            .into_iter()
            .flat_map(|m| match m {
                SourceMessage::Frames(_, frames) => frames,
                _ => Vec::new(),
            })
            .collect()
    }

    #[test]
    fn a_zero_byte_read_ends_the_source_as_disconnected() {
        let ended = line_lost(2, "/dev/test", SerialError::Closed, |_| unreachable!());
        assert!(matches!(
            ended,
            SourceMessage::Ended(2, EndReason::Disconnected)
        ));
    }

    #[test]
    fn a_read_error_is_classified_by_whether_the_port_still_enumerates() {
        let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let message =
            |presence| match line_lost(2, "/dev/test", SerialError::Read(denied()), |port| {
                assert_eq!(port, "/dev/test");
                presence
            }) {
                SourceMessage::Error(2, message) => message,
                _ => panic!("a read error is a source error"),
            };
        for presence in [DevicePresence::Present, DevicePresence::Absent] {
            let expected = IoError::device_stream_error_message("/dev/test", &denied(), presence);
            assert_eq!(message(presence), expected);
        }
        assert_ne!(
            message(DevicePresence::Present),
            message(DevicePresence::Absent)
        );
    }

    #[test]
    fn a_refused_write_reports_why() {
        assert_eq!(transmit_result(Ok(Ok(()))), Ok(()));
        assert_eq!(
            transmit_result(Err(WriteRefused::Disconnected)),
            Err("Write refused: not connected".to_string())
        );
        let failed = transmit_result(Ok(Err(std::io::ErrorKind::BrokenPipe.into())));
        assert!(failed.unwrap_err().starts_with("Write error: "));
    }

    #[test]
    fn rtu_messages_in_one_read_are_stamped_at_their_own_last_byte() {
        let request = rtu(&[0x01, 0x03, 0x00, 0x00, 0x00, 0x01]);
        let response = rtu(&[0x01, 0x03, 0x02, 0x12, 0x34]);
        let mut line = live(
            FramingEncoding::ModbusRtu(ModbusRtuOptions::default()),
            false,
        );

        let got = frames(line.read(&[&request[..], &response[..]].concat(), at(1_000_000)));

        assert_eq!(
            got.iter().map(|f| f.bytes.clone()).collect::<Vec<_>>(),
            [request, response]
        );
        // The response's 7 bytes follow the request's last one: 7 × 10 bits at 9600 baud.
        assert_eq!(
            got.iter().map(|f| f.timestamp_us).collect::<Vec<_>>(),
            [1_000_000 - 7_291, 1_000_000]
        );
    }

    #[test]
    fn a_declared_vendor_code_is_framed_on_the_live_line() {
        let vendor = rtu(&[0x01, 0x65, 0x03, 0x00, 0x00, 0x01, 0x00, 0x01]);
        let options = ModbusRtuOptions {
            vendor_functions: vec![0x65],
            ..Default::default()
        };
        let mut line = live(FramingEncoding::ModbusRtu(options), false);

        let got = frames(line.read(&vendor, at(1_000_000)));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].bytes, vendor);
    }

    #[test]
    fn raw_bytes_are_back_dated_by_wire_time_and_never_go_backwards() {
        let mut line = live(FramingEncoding::Raw, true);
        let stamps = |messages: Vec<SourceMessage>| match &messages[..] {
            [SourceMessage::Bytes(0, entries)] => {
                entries.iter().map(|e| e.timestamp_us).collect::<Vec<_>>()
            }
            _ => panic!("a raw line yields one byte batch and no frames"),
        };

        assert_eq!(
            stamps(line.read(&[1, 2, 3], at(1_000_000))),
            [997_917, 998_959, 1_000_000]
        );
        assert_eq!(
            stamps(line.read(&[4, 5], at(1_000_500))),
            [1_000_000, 1_000_500],
            "floored at the last stamp handed out"
        );
    }

    #[test]
    fn a_framing_change_swaps_the_framer_in_place() {
        let mut line = live(FramingEncoding::Raw, false);
        assert!(line.read(b"hello\n", at(1)).is_empty());

        line.set_framing(SetFramingRequest {
            encoding: "delimiter".to_string(),
            frame_id_start_byte: Some(0),
            frame_id_bytes: None,
            frame_id_big_endian: true,
            source_address_start_byte: None,
            source_address_bytes: None,
            source_address_big_endian: true,
            min_frame_length: 0,
            emit_raw_bytes: false,
            modbus: None,
        });

        let got = frames(line.read(b"hello\n", at(2)));
        assert_eq!(got.len(), 1);
        assert_eq!(
            (
                got[0].bytes.as_slice(),
                got[0].frame_id,
                got[0].timestamp_us
            ),
            (&b"hello"[..], u32::from(b'h'), 2)
        );
    }
}

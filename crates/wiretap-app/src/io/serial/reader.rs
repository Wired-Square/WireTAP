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
use wiretap_catalog::{Catalog, RtuTap, TappedMessage};
use wiretap_io::serial::{
    self, ports, Access, LineSettings, PortInfo, PortKind, SerialError, SerialEvent,
    SerialOptions, SerialWriter, WriteRefused,
};

use crate::io::bus_mapping::{apply_bus_mapping, BusMapping};
use crate::io::error::DevicePresence;
use crate::io::types::{
    ByteEntry, EndReason, ModbusRtuOptions, SetFramingRequest, SourceMessage, TransmitRequest,
};
use crate::io::FrameMessage;

use super::framer::{
    residue, rtu_frame, FrameIdConfig, FramingEncoding, SerialFrame, SerialFramer,
};
use super::utils::{framing_from_str, outage_message, probe_serial_presence, SerialSourceConfig};

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
    Serial(SerialFramer, LineSettings),
    /// Stamps each message at its last byte, rather than at the read that
    /// released it.
    Rtu(RtuTap, ModbusRtuOptions),
}

impl Framer {
    fn new(encoding: FramingEncoding, line: LineSettings, catalog: Option<&Catalog>) -> Self {
        match encoding {
            FramingEncoding::ModbusRtu(options) => {
                Self::Rtu(RtuTap::new(&options.with_catalog(catalog), line), options)
            }
            encoding => SerialFramer::new(encoding)
                .map_or(Self::Unframed, |framer| Self::Serial(framer, line)),
        }
    }

    fn feed(&mut self, bytes: &[u8], at: SystemTime) -> Vec<(SerialFrame, u64)> {
        match self {
            Self::Unframed => Vec::new(),
            Self::Serial(framer, line) => {
                let frames = framer.feed(bytes);
                let fed = framer.bytes_fed();
                let at_us = micros(at);
                frames
                    .into_iter()
                    .map(|f| {
                        let behind = line.wire_time(fed - f.end_offset).as_micros() as u64;
                        (f, at_us.saturating_sub(behind))
                    })
                    .collect()
            }
            Self::Rtu(tap, _) => tap.push(bytes, at).into_iter().map(tapped).collect(),
        }
    }

    /// End of stream. Modbus RTU can still recover whole messages from what it
    /// holds, so this is a list, not one residue.
    fn finish(&mut self, now: SystemTime) -> Vec<(SerialFrame, u64)> {
        match self {
            Self::Unframed => Vec::new(),
            Self::Serial(framer, _) => stamped(framer.flush(), now),
            Self::Rtu(tap, _) => {
                let (messages, trailing) = tap.finish();
                let leftover = stamped(residue(trailing, tap.bytes_fed()), now);
                tap.reset();
                messages.into_iter().map(tapped).chain(leftover).collect()
            }
        }
    }
}

/// What a live serial source makes of each read, with the framing a
/// `SetFraming` request swaps in place.
struct LiveLine {
    source_idx: usize,
    port: String,
    line: LineSettings,
    output_bus: u8,
    bus_mappings: Vec<BusMapping>,
    framer: Framer,
    /// The session's attached catalogue, whose function codes RTU framing takes.
    catalog: Option<Arc<Catalog>>,
    frame_id_config: Option<FrameIdConfig>,
    source_address_config: Option<FrameIdConfig>,
    min_frame_length: usize,
    emit_raw_bytes: bool,
    /// No byte is stamped before one already handed out, as `RtuTap`'s floor.
    byte_floor_us: u64,
    waiting_for_device: bool,
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
            port: config.port,
            line: config.line,
            output_bus,
            bus_mappings,
            framer: Framer::new(config.framing_encoding, config.line, None),
            catalog: None,
            frame_id_config: config.frame_id_config,
            source_address_config: config.source_address_config,
            min_frame_length: config.min_frame_length,
            emit_raw_bytes: config.emit_raw_bytes,
            byte_floor_us: 0,
            waiting_for_device: false,
        }
    }

    /// A loss is reported once per outage, and flushes the framer so no half
    /// message is glued onto what the device sends when it returns.
    fn on_event(
        &mut self,
        event: SerialEvent,
        presence: impl FnOnce(&str) -> DevicePresence,
    ) -> Vec<SourceMessage> {
        match event {
            SerialEvent::Connected => {
                if std::mem::take(&mut self.waiting_for_device) {
                    tlog!(
                        "[serial] Source {} reconnected to {}",
                        self.source_idx,
                        self.port
                    );
                    self.byte_floor_us = self.byte_floor_us.max(micros(SystemTime::now()));
                }
                vec![SourceMessage::Connected(
                    self.source_idx,
                    "serial".to_string(),
                    self.port.clone(),
                    Some(self.output_bus),
                )]
            }
            SerialEvent::Read { bytes, at } => self.read(&bytes, at),
            SerialEvent::Disconnected { .. } if self.waiting_for_device => Vec::new(),
            SerialEvent::Disconnected { error, .. } => {
                self.waiting_for_device = true;
                let message = outage_message(&self.port, error.into(), presence);
                tlog!("[serial] Source {} {}", self.source_idx, message);
                self.finish()
                    .into_iter()
                    .chain([SourceMessage::Interrupted(self.source_idx, message)])
                    .collect()
            }
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

    fn stopped(&mut self) -> Vec<SourceMessage> {
        let ended = SourceMessage::Ended(self.source_idx, EndReason::Stopped);
        self.finish().into_iter().chain([ended]).collect()
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
                let extract = |cfg: &Option<FrameIdConfig>| cfg.as_ref()?.extract(&frame.bytes);
                let frame_id = extract(&self.frame_id_config).unwrap_or(0);
                let source_address = extract(&self.source_address_config).map(|v| v as u16);

                // `frame.crc_valid` is deliberately not carried: the decode path
                // recomputes it from these same bytes. See `framing.rs`.
                let mut msg = FrameMessage {
                    protocol: "serial".to_string(),
                    timestamp_us,
                    frame_id,
                    bus: 0,
                    dlc: frame.bytes.len() as u16,
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
            self.catalog.as_deref(),
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

    /// Rebuilds RTU framing when the session's catalogue is attached, swapped
    /// or detached, dropping any partial message as a framing change does.
    fn follow_catalog(&mut self, catalog: Option<Arc<Catalog>>) {
        if catalog.as_ref().map(Arc::as_ptr) == self.catalog.as_ref().map(Arc::as_ptr) {
            return;
        }
        if let Framer::Rtu(_, options) = &self.framer {
            let encoding = FramingEncoding::ModbusRtu(options.clone());
            self.framer = Framer::new(encoding, self.line, catalog.as_deref());
        }
        self.catalog = catalog;
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
    attached_catalog: impl Fn() -> Option<Arc<Catalog>>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let port = config.port.clone();
    let options = SerialOptions {
        access: Access::ReadWrite,
        read_buffer: 256,
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
    loop {
        tokio::select! {
            event = task.next_event() => match event {
                Some(event) => {
                    for message in live.on_event(event, probe_serial_presence) {
                        let _ = tx.send(message).await;
                    }
                }
                None => {
                    let _ = tx.send(SourceMessage::Ended(source_idx, EndReason::Disconnected)).await;
                    return;
                }
            },
            _ = poll.tick() => {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                live.follow_catalog(attached_catalog());
                while let Ok(req) = control_rx.try_recv() {
                    live.set_framing(req);
                }
            }
        }
    }

    task.stop().await;
    for message in live.stopped() {
        let _ = tx.send(message).await;
    }
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
    let ports = ports().map_err(|e| format!("Failed to enumerate ports: {}", e))?;

    Ok(ports
        .into_iter()
        // On macOS, filter out /dev/tty.* devices - only show /dev/cu.* (calling unit)
        .filter(|_p| {
            #[cfg(target_os = "macos")]
            {
                !_p.path.starts_with("/dev/tty.")
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        })
        .map(serial_port_info)
        .collect())
}

fn serial_port_info(port: PortInfo) -> SerialPortInfo {
    let (port_type, usb) = match port.kind {
        PortKind::Usb(usb) => ("USB", Some(usb)),
        PortKind::Bluetooth => ("Bluetooth", None),
        PortKind::Pci => ("PCI", None),
        _ => ("Unknown", None),
    };
    let (manufacturer, product, serial_number, vid, pid) = match usb {
        Some(usb) => (usb.manufacturer, usb.product, usb.serial, Some(usb.vid), Some(usb.pid)),
        None => (None, None, None, None, None),
    };
    SerialPortInfo {
        port_name: port.path,
        port_type: port_type.to_string(),
        manufacturer,
        product,
        serial_number,
        vid,
        pid,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::serial::DelimiterOptions;
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

    fn lost(error: SerialError) -> SerialEvent {
        SerialEvent::Disconnected {
            error,
            consecutive: 1,
            retry_in: Some(Duration::from_secs(1)),
        }
    }

    fn reopen_failed() -> SerialEvent {
        let source = std::io::Error::from(std::io::ErrorKind::NotFound);
        SerialEvent::Disconnected {
            error: SerialError::Open {
                path: "/dev/test".to_string(),
                source,
            },
            consecutive: 2,
            retry_in: Some(Duration::from_secs(1)),
        }
    }

    fn present(_: &str) -> DevicePresence {
        DevicePresence::Present
    }

    #[test]
    fn a_loss_while_live_is_reported_once_and_does_not_end_the_source() {
        let mut line = live(FramingEncoding::Raw, false);

        match &line.on_event(lost(SerialError::Closed), |_| unreachable!())[..] {
            [SourceMessage::Interrupted(0, message)] => assert_eq!(
                message,
                "/dev/test: device disconnected, waiting for it to return"
            ),
            _ => panic!("one interruption, and no ending"),
        }
        assert!(line.on_event(reopen_failed(), present).is_empty());
        assert!(line.on_event(lost(SerialError::Closed), present).is_empty());
    }

    #[test]
    fn a_read_error_is_classified_by_whether_the_port_still_enumerates() {
        let denied = || SerialError::Read(std::io::ErrorKind::PermissionDenied.into());
        let message = |presence| {
            let mut line = live(FramingEncoding::Raw, false);
            match line
                .on_event(lost(denied()), |port| {
                    assert_eq!(port, "/dev/test");
                    presence
                })
                .pop()
            {
                Some(SourceMessage::Interrupted(0, message)) => message,
                _ => panic!("a read error interrupts the source"),
            }
        };
        assert_eq!(
            message(DevicePresence::Present),
            "/dev/test: device unavailable, it may be in use by another application, \
             waiting for it to return"
        );
        assert_eq!(
            message(DevicePresence::Absent),
            "/dev/test: device disconnected, waiting for it to return"
        );
    }

    #[test]
    fn a_reconnect_resumes_with_the_framer_flushed_at_the_loss() {
        let request = rtu(&[0x01, 0x03, 0x00, 0x00, 0x00, 0x01]);
        let response = rtu(&[0x01, 0x03, 0x02, 0x12, 0x34]);
        let mut line = live(
            FramingEncoding::ModbusRtu(ModbusRtuOptions::default()),
            false,
        );
        assert!(line.read(&request[..4], at(1_000_000)).is_empty());

        let at_loss = frames(line.on_event(lost(SerialError::Closed), present));
        assert_eq!(at_loss.len(), 1);
        assert_eq!(at_loss[0].bytes, request[..4]);
        assert_eq!(at_loss[0].incomplete, Some(true));

        assert!(matches!(
            line.on_event(SerialEvent::Connected, present)[..],
            [SourceMessage::Connected(0, _, _, Some(0))]
        ));
        let resumed = frames(line.read(&response, at(2_000_000)));
        assert_eq!(
            resumed.iter().map(|f| f.bytes.clone()).collect::<Vec<_>>(),
            [response]
        );
        assert!(
            !line.on_event(lost(SerialError::Closed), present).is_empty(),
            "a new outage is reported again"
        );
    }

    #[test]
    fn raw_bytes_after_a_reconnect_are_not_stamped_before_it() {
        let mut line = live(FramingEncoding::Raw, true);
        line.on_event(lost(SerialError::Closed), present);
        let before = micros(SystemTime::now());
        line.on_event(SerialEvent::Connected, present);

        let messages = line.on_event(
            SerialEvent::Read {
                bytes: vec![1, 2, 3],
                at: at(1_000_000),
            },
            present,
        );
        let [SourceMessage::Bytes(0, entries)] = &messages[..] else {
            panic!("a raw line yields one byte batch");
        };
        assert!(entries.iter().all(|e| e.timestamp_us >= before));
    }

    #[test]
    fn a_stop_while_waiting_ends_stopped_with_nothing_left_to_flush() {
        let mut line = live(
            FramingEncoding::Delimiter(DelimiterOptions {
                delimiter: vec![b'\n'],
                max_length: 64,
                include_delimiter: false,
            }),
            false,
        );
        line.read(b"half", at(1));
        line.on_event(lost(SerialError::Closed), present);

        assert!(matches!(
            line.stopped()[..],
            [SourceMessage::Ended(0, EndReason::Stopped)]
        ));
    }

    #[test]
    fn a_frame_over_255_bytes_counts_every_byte() {
        let mut line = live(
            FramingEncoding::Delimiter(DelimiterOptions {
                delimiter: vec![b'\n'],
                max_length: 512,
                include_delimiter: false,
            }),
            false,
        );

        let got = frames(line.read(&[[b'x'; 256].as_slice(), b"\n"].concat(), at(1)));

        assert_eq!(usize::from(got[0].dlc), got[0].bytes.len());
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
    fn slip_frames_in_one_read_are_stamped_at_their_own_last_byte() {
        let mut line = live(FramingEncoding::Slip, false);

        let got = frames(line.read(&[1, 2, 0xC0, 3, 4, 0xC0], at(1_000_000)));

        // The second frame's 3 bytes follow the first's END: 3 × 10 bits at 9600 baud.
        assert_eq!(
            got.iter().map(|f| f.timestamp_us).collect::<Vec<_>>(),
            [1_000_000 - 3_125, 1_000_000]
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

    /// A 0x60 of 19 bytes whose first 18 also pass their CRC: the picker's
    /// declaration alone frames it short, the catalogue's length rule whole.
    #[test]
    fn an_attached_catalogue_frames_its_vendor_code_by_rule() {
        let dispatch = rtu(&[
            0x00, 0x60, 0x12, 0x34, 0x00, 0x01, 0x0A, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
            0x00, 0x00, 0x64,
        ]);
        assert_eq!(
            rtu(&dispatch[..16]),
            dispatch[..18],
            "the fixture is not ambiguous"
        );
        let options = ModbusRtuOptions {
            vendor_functions: vec![0x60],
            allow_broadcast: true,
            ..Default::default()
        };
        let catalog = Catalog::parse(
            r#"
[meta]
name = "line"
[meta.modbus.function_code.0x60]
lengths = [{ len = { count_at = 6, overhead = 9 } }]
"#,
        )
        .unwrap();
        let framed_len = |line: &mut LiveLine| -> Vec<usize> {
            let got = frames(line.read(&dispatch, at(1_000_000)));
            got.iter().map(|f| f.bytes.len()).collect()
        };

        let mut line = live(FramingEncoding::ModbusRtu(options), false);
        assert_eq!(framed_len(&mut line), [18]);

        line.follow_catalog(Some(Arc::new(catalog)));
        assert_eq!(framed_len(&mut line), [19]);
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

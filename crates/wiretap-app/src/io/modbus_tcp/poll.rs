// io/modbus_tcp/poll.rs
//
// The one Modbus poll loop.
//
// Two call sites drive Modbus polling: the standalone `ModbusTcpSource`
// (`reader.rs`, used by the MCP/headless open path) and the broker's
// multi-source spawner (`broker/spawner.rs`, used by the app). They ran
// near-identical copies of the same loop, which drifted: the broker copy never
// pointed the shared context at the poll's slave, so every register in a
// multi-slave catalogue was silently read from the connection's `unit_id`, and
// it reported the session's output bus rather than the device address. This
// module is that loop, once, with every sink behind `FrameSink`.
//
// The per-tick mutable state (throttle, error counters) stays inside
// `run_poll_task` rather than moving into the sink — same reasoning as
// `io/periodic.rs`: a closure-based runner would force the state into
// Arc/Mutex or hit async-closure `Send` limits on stable Rust.

use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_modbus::client;
use tokio_modbus::prelude::*;

use super::reader::{PollEmitMode, PollGroup, RegisterType};
use wiretap_catalog::modbus::{coils_to_bytes, registers_to_bytes};
use crate::capture_store;
use crate::io::periodic::Cadence;
use crate::io::types::SourceMessage;
use crate::io::{emit_session_error, now_us, signal_frames_ready, FrameMessage, SignalThrottle};

// ============================================================================
// Read result
// ============================================================================

/// A successful read, still in its natural shape. Kept typed (rather than
/// flattened to bytes at the read site) so `PollEmitMode::PerRegister` can split
/// it per register — one flat `Vec<u8>` can't tell you where the coils end.
pub enum ReadData {
    Registers(Vec<u16>),
    Coils(Vec<bool>),
}

pub fn register_type_name(rt: &RegisterType) -> &'static str {
    match rt {
        RegisterType::Holding => "holding",
        RegisterType::Input => "input",
        RegisterType::Coil => "coil",
        RegisterType::Discrete => "discrete",
    }
}

/// Read one block. `Ok` is a successful read, `Err` covers both Modbus
/// exceptions and IO errors — the poll loop treats them alike (the scanner,
/// which must tell them apart, has its own richer outcome type).
pub async fn read_block(
    ctx: &mut client::Context,
    register_type: &RegisterType,
    start: u16,
    count: u16,
) -> Result<ReadData, String> {
    match register_type {
        RegisterType::Holding => match ctx.read_holding_registers(start, count).await {
            Ok(Ok(data)) => Ok(ReadData::Registers(data)),
            Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Input => match ctx.read_input_registers(start, count).await {
            Ok(Ok(data)) => Ok(ReadData::Registers(data)),
            Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Coil => match ctx.read_coils(start, count).await {
            Ok(Ok(data)) => Ok(ReadData::Coils(data)),
            Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Discrete => match ctx.read_discrete_inputs(start, count).await {
            Ok(Ok(data)) => Ok(ReadData::Coils(data)),
            Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
            Err(e) => Err(format!("IO error: {}", e)),
        },
    }
}

// ============================================================================
// Frame construction
// ============================================================================

/// Build a Modbus frame. `bus` carries the device (slave) address, which is what
/// makes a multi-slave session readable in the UI.
pub fn modbus_frame(frame_id: u32, device_address: u8, bytes: Vec<u8>) -> FrameMessage {
    FrameMessage {
        protocol: "modbus".to_string(),
        timestamp_us: now_us(),
        frame_id,
        bus: device_address,
        dlc: bytes.len() as u8,
        bytes,
        is_extended: false,
        is_fd: false,
        source_address: None,
        incomplete: None,
        direction: Some("rx".to_string()),
    }
}

/// Turn a read into frames.
///
/// `Block` emits the whole response as one frame at the group's `frame_id` —
/// required for catalogue polls, whose signals are bit offsets into the entire
/// block and would decode to nonsense if split.
///
/// `PerRegister` emits one frame per register keyed by its address, which is what
/// makes discovery sweeps analysable: the Changes tool then answers "which
/// register moved" rather than "which block moved".
pub fn frames_for_read(poll: &PollGroup, data: ReadData) -> Vec<FrameMessage> {
    match (poll.emit_mode, data) {
        (PollEmitMode::Block, ReadData::Registers(regs)) => {
            vec![modbus_frame(
                poll.frame_id,
                poll.device_address,
                registers_to_bytes(&regs),
            )]
        }
        (PollEmitMode::Block, ReadData::Coils(coils)) => {
            vec![modbus_frame(
                poll.frame_id,
                poll.device_address,
                coils_to_bytes(&coils),
            )]
        }
        (PollEmitMode::PerRegister, data) => {
            per_register_frames(poll.start_register, poll.device_address, data)
        }
    }
}

/// One frame per address, keyed by the address itself: a register carries its
/// two big-endian bytes, a coil its single 0/1 byte. Shared with the discovery
/// sweeps, which emit the same shape.
pub fn per_register_frames(start: u16, device_address: u8, data: ReadData) -> Vec<FrameMessage> {
    let at = |i: usize| start.wrapping_add(i as u16) as u32;
    match data {
        ReadData::Registers(regs) => regs
            .iter()
            .enumerate()
            .map(|(i, &reg)| {
                modbus_frame(at(i), device_address, vec![(reg >> 8) as u8, (reg & 0xFF) as u8])
            })
            .collect(),
        ReadData::Coils(coils) => coils
            .iter()
            .enumerate()
            .map(|(i, &coil)| modbus_frame(at(i), device_address, vec![u8::from(coil)]))
            .collect(),
    }
}

// ============================================================================
// Sink
// ============================================================================

/// Where Modbus frames go — shared by the poll loop and the discovery sweeps,
/// which both produce frames and both need the capture-plus-throttle path.
pub enum FrameSink {
    /// Standalone `ModbusTcpSource` / scan session: write into the session's
    /// frame capture and throttle-signal the WS.
    SessionCapture { session_id: String },
    /// Broker multi-source: hand frames to the merge task.
    Broker {
        source_idx: usize,
        tx: mpsc::Sender<SourceMessage>,
    },
    /// Throw them away. A sweep with no session has nowhere to put frames and
    /// gets only the summary — buffering what it can never read would be waste.
    Discard,
}

impl FrameSink {
    /// Log prefix identifying the sink, so every path's logs stay greppable.
    pub fn label(&self) -> String {
        match self {
            FrameSink::SessionCapture { session_id } => format!("[ModbusTCP:{}]", session_id),
            FrameSink::Broker { source_idx, .. } => {
                format!("[multi_source] Modbus source {}", source_idx)
            }
            FrameSink::Discard => "[modbus]".to_string(),
        }
    }

    pub async fn frames(&self, frames: Vec<FrameMessage>, throttle: &mut SignalThrottle) {
        if frames.is_empty() {
            return;
        }
        match self {
            FrameSink::SessionCapture { session_id } => {
                capture_store::append_frames_to_session(session_id, frames);
                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(session_id);
                }
            }
            FrameSink::Broker { source_idx, tx } => {
                let _ = tx.send(SourceMessage::Frames(*source_idx, frames)).await;
            }
            FrameSink::Discard => {}
        }
    }

    /// Push any frames still held behind the signal throttle. A sweep ends
    /// abruptly, so without this its last batch waits for a tick that never comes.
    pub fn flush(&self, throttle: &mut SignalThrottle) {
        if let FrameSink::SessionCapture { session_id } = self {
            throttle.flush();
            signal_frames_ready(session_id);
        }
    }

    /// Surface a read error. The broker path deliberately stays silent: the merge
    /// task already reports source-level failures, and a per-register error on one
    /// of many poll groups is a log line, not a session error.
    fn error(&self, message: String) {
        if let FrameSink::SessionCapture { session_id } = self {
            emit_session_error(session_id, message);
        }
    }
}

// ============================================================================
// Poll task
// ============================================================================

/// Poll one register group on its interval until cancelled, paused-through, or
/// stopped by `max_register_errors` consecutive failures (0 = never give up).
pub async fn run_poll_task(
    poll: PollGroup,
    ctx: Arc<Mutex<client::Context>>,
    max_register_errors: u32,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    sink: FrameSink,
) {
    let mut cadence = Cadence::new(poll.interval_ms, cancel, Some(pause));
    let type_name = register_type_name(&poll.register_type);
    let label = sink.label();
    let mut first_poll = true;
    let mut consecutive_errors: u32 = 0;
    let mut throttle = SignalThrottle::new();

    tlog!(
        "{} poll task started: {} reg {} count {} every {}ms (frame_id={}, slave={}, emit={:?})",
        label,
        type_name,
        poll.start_register,
        poll.count,
        poll.interval_ms,
        poll.frame_id,
        poll.device_address,
        poll.emit_mode
    );

    while cadence.next().await.is_some() {
        let result = {
            let mut ctx = ctx.lock().await;
            // One TCP connection multiplexes all slaves: point the shared context
            // at this poll's device address before reading. Done inside the held
            // lock so concurrent poll tasks can't race the slave id.
            ctx.set_slave(Slave(poll.device_address));
            read_block(&mut ctx, &poll.register_type, poll.start_register, poll.count).await
        };

        match result {
            Ok(data) => {
                consecutive_errors = 0;

                let frames = frames_for_read(&poll, data);

                if first_poll {
                    tlog!(
                        "{} first poll OK: {} reg {} → {} frame(s)",
                        label,
                        type_name,
                        poll.start_register,
                        frames.len()
                    );
                    first_poll = false;
                }

                sink.frames(frames, &mut throttle).await;
            }
            Err(e) => {
                consecutive_errors += 1;

                tlog!(
                    "{} error reading {} at {}: {} ({}/{})",
                    label,
                    type_name,
                    poll.start_register,
                    e,
                    consecutive_errors,
                    if max_register_errors > 0 {
                        max_register_errors.to_string()
                    } else {
                        "∞".to_string()
                    }
                );
                sink.error(format!(
                    "Modbus read error ({} @ {}): {}",
                    type_name, poll.start_register, e
                ));

                if max_register_errors > 0 && consecutive_errors >= max_register_errors {
                    tlog!(
                        "{} stopped polling {} reg {} after {} consecutive errors",
                        label,
                        type_name,
                        poll.start_register,
                        consecutive_errors
                    );
                    sink.error(format!(
                        "Stopped polling {} @ {} after {} consecutive errors",
                        type_name, poll.start_register, consecutive_errors
                    ));
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll(register_type: RegisterType, start: u16, count: u16, emit: PollEmitMode) -> PollGroup {
        PollGroup {
            register_type,
            start_register: start,
            count,
            interval_ms: 1000,
            frame_id: 13007,
            device_address: 3,
            emit_mode: emit,
        }
    }

    #[test]
    fn block_mode_emits_one_frame_for_the_whole_read() {
        let p = poll(RegisterType::Holding, 100, 2, PollEmitMode::Block);
        let frames = frames_for_read(&p, ReadData::Registers(vec![0x1234, 0xABCD]));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].frame_id, 13007);
        assert_eq!(frames[0].bytes, vec![0x12, 0x34, 0xAB, 0xCD]);
        assert_eq!(frames[0].dlc, 4);
    }

    #[test]
    fn per_register_mode_keys_each_frame_by_its_address() {
        let p = poll(RegisterType::Holding, 100, 3, PollEmitMode::PerRegister);
        let frames = frames_for_read(&p, ReadData::Registers(vec![0x0001, 0xFFFF, 0x4D42]));
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames.iter().map(|f| f.frame_id).collect::<Vec<_>>(),
            vec![100, 101, 102]
        );
        assert_eq!(frames[1].bytes, vec![0xFF, 0xFF]);
        assert!(frames.iter().all(|f| f.dlc == 2));
    }

    #[test]
    fn every_frame_carries_the_slave_address_as_its_bus() {
        let p = poll(RegisterType::Input, 0, 2, PollEmitMode::PerRegister);
        let frames = frames_for_read(&p, ReadData::Registers(vec![1, 2]));
        assert!(frames.iter().all(|f| f.bus == 3));
    }

    #[test]
    fn per_register_coils_emit_one_byte_each() {
        let p = poll(RegisterType::Coil, 8, 3, PollEmitMode::PerRegister);
        let frames = frames_for_read(&p, ReadData::Coils(vec![true, false, true]));
        assert_eq!(
            frames.iter().map(|f| (f.frame_id, f.bytes.clone())).collect::<Vec<_>>(),
            vec![(8, vec![1]), (9, vec![0]), (10, vec![1])]
        );
    }

    #[test]
    fn block_coils_stay_packed_lsb_first() {
        let p = poll(RegisterType::Coil, 0, 3, PollEmitMode::Block);
        let frames = frames_for_read(&p, ReadData::Coils(vec![true, false, true]));
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, vec![0b0000_0101]);
    }

    /// A block-mode coil read decodes as the coils that were read. Pinned
    /// against the catalogue crate: before v0.16.4 a coil frame took the Modbus
    /// default byte order, big, whose bit numbering reads coil 7 − n for coil n.
    /// The catalogue here sets no order at all — the stock case was the broken
    /// one — and coil 7 is off so the mirror cannot pass by luck.
    #[test]
    fn block_coils_decode_as_the_coils_that_were_read() {
        use wiretap_catalog::{decode::decode_by_id, model::Catalog};
        let catalog = Catalog::parse(
            r#"
[meta]
name = "relay"
[meta.modbus]
register_base = 0
[frame.modbus.13007]
register_type = "coil"
length = 24
[[frame.modbus.13007.signals]]
name = "Coil0"
start_bit = 0
bit_length = 1
[[frame.modbus.13007.signals]]
name = "Coil3"
start_bit = 3
bit_length = 1
[[frame.modbus.13007.signals]]
name = "Coil17"
start_bit = 17
bit_length = 1
[[frame.modbus.13007.signals]]
name = "Wide"
start_bit = 0
bit_length = 20
"#,
        )
        .unwrap();
        let mut coils = vec![false; 24];
        for i in [0, 3, 8, 17] {
            coils[i] = true;
        }
        let p = poll(RegisterType::Coil, 13007, 24, PollEmitMode::Block);
        let frames = frames_for_read(&p, ReadData::Coils(coils));
        assert_eq!(frames[0].bytes, vec![0x09, 0x01, 0x02]);

        let d = decode_by_id(&catalog, frames[0].frame_id, &frames[0].bytes).unwrap();
        let value = |n: &str| d.signals.iter().find(|s| s.name == n).unwrap().scaled;
        assert_eq!(value("Coil0"), 1.0);
        assert_eq!(value("Coil3"), 1.0);
        assert_eq!(value("Coil17"), 1.0);
        assert_eq!(value("Wide"), 131_337.0); // 0x020109, coils 0·3·8·17
    }
}

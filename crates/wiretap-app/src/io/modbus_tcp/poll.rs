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
// module is that loop, once: one `wiretap_io` poll task per source, drained
// into a `FrameSink`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, watch};
use wiretap_io::modbus::{
    spawn, tcp_endpoint, ModbusTcp, PollEvent, PollTask, PollWriter, Poller, TaskEvent,
    TaskOptions, TcpOptions, TransportError, UnitSource,
};

use super::reader::{PollEmitMode, PollGroup};
use wiretap_catalog::modbus::{coils_to_bytes, registers_to_bytes, FrameBackoff};
use crate::capture_store;
use crate::io::types::SourceMessage;
use crate::io::{emit_session_error, now_us, signal_frames_ready, FrameMessage, SignalThrottle};

pub use wiretap_io::modbus::ReadData;

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
///
/// Every frame is stamped `at`, when the read completed.
pub fn frames_for_read(poll: &PollGroup, data: ReadData, at: SystemTime) -> Vec<FrameMessage> {
    let mut frames = match (poll.emit_mode, data) {
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
    };
    let timestamp_us = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64);
    for frame in &mut frames {
        frame.timestamp_us = timestamp_us;
    }
    frames
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

const POLL_OP_TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_RECONNECT: Duration = Duration::from_secs(20);

/// What a source asks of its running poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PollControl {
    Run,
    Pause,
    Stop,
}

/// A connection to a Modbus profile's device with the poll's timeouts. It
/// connects on first use.
pub fn device_connection(host: &str, port: u16, unit_id: u8) -> ModbusTcp {
    let options = TcpOptions {
        op_timeout: POLL_OP_TIMEOUT,
        idle_reconnect: Some(IDLE_RECONNECT),
        unit_id,
        ..TcpOptions::default()
    };
    ModbusTcp::new(tcp_endpoint(host, port), options)
}

/// Connect, then spawn one poll task for all of a source's groups. Connecting
/// first means a device that is down fails the session start.
pub async fn start_polling(
    host: &str,
    port: u16,
    unit_id: u8,
    polls: &[PollGroup],
) -> Result<PollTask<PollGroup>, String> {
    let mut conn = device_connection(host, port, unit_id);
    conn.connect()
        .await
        .map_err(|e| format!("Failed to connect to Modbus TCP server: {e}"))?;
    Ok(spawn_polls(conn, polls, TaskOptions::default()))
}

type WriterKey = (String, String);

static POLL_WRITERS: LazyLock<Mutex<HashMap<WriterKey, (u64, PollWriter)>>> =
    LazyLock::new(Default::default);
static NEXT_REGISTRATION: AtomicU64 = AtomicU64::new(0);

/// Keeps a running poll's writer reachable by its session and source profile
/// until dropped.
pub struct WriterRegistration {
    key: WriterKey,
    id: u64,
}

pub fn register_writer(session_id: &str, profile_id: &str, writer: PollWriter) -> WriterRegistration {
    let key = (session_id.to_string(), profile_id.to_string());
    let id = NEXT_REGISTRATION.fetch_add(1, Ordering::Relaxed);
    POLL_WRITERS.lock().unwrap().insert(key.clone(), (id, writer));
    WriterRegistration { key, id }
}

/// The writer of the poll running for `profile_id` in `session_id`, if any.
pub fn poll_writer(session_id: &str, profile_id: &str) -> Option<PollWriter> {
    let key = (session_id.to_string(), profile_id.to_string());
    POLL_WRITERS.lock().unwrap().get(&key).map(|(_, writer)| writer.clone())
}

impl Drop for WriterRegistration {
    fn drop(&mut self) {
        // A restarted source may register its new poll before the old one ends.
        let mut writers = POLL_WRITERS.lock().unwrap();
        if writers.get(&self.key).is_some_and(|(id, _)| *id == self.id) {
            writers.remove(&self.key);
        }
    }
}

fn spawn_polls(conn: ModbusTcp, polls: &[PollGroup], options: TaskOptions) -> PollTask<PollGroup> {
    let items = polls.iter().map(PollGroup::to_item);
    let poller = Poller::new(
        items,
        UnitSource::Item,
        FrameBackoff::default(),
        Instant::now(),
    );
    spawn(conn, poller, options)
}

/// Whether a run of `consecutive` failures has reached `limit`; 0 never does.
fn exhausted(consecutive: u32, limit: u32) -> bool {
    limit > 0 && consecutive >= limit
}

enum Wake {
    Event(Option<TaskEvent<PollGroup>>),
    Control(PollControl),
}

/// Drain `task` into `sink` until `control` says stop, every group has been
/// retired after `max_register_errors` consecutive transport errors, or the
/// device has stayed unreachable for that many connection attempts. A Modbus
/// exception backs its group off instead of counting.
pub async fn run_poll_task(
    mut task: PollTask<PollGroup>,
    mut control: watch::Receiver<PollControl>,
    sink: FrameSink,
    max_register_errors: u32,
) {
    let mut drain = Drain {
        label: sink.label(),
        sink,
        max_register_errors,
        throttle: SignalThrottle::new(),
        first_poll: true,
    };
    let mut connects = 0u32;

    loop {
        let wake = tokio::select! {
            event = task.next_event() => Wake::Event(event),
            changed = control.changed() => Wake::Control(match changed {
                Ok(()) => *control.borrow_and_update(),
                Err(_) => PollControl::Stop,
            }),
        };
        match wake {
            Wake::Control(PollControl::Run) => task.resume(),
            Wake::Control(PollControl::Pause) => task.pause(),
            Wake::Control(PollControl::Stop) => break,
            Wake::Event(None | Some(TaskEvent::AllRetired)) => return,
            Wake::Event(Some(TaskEvent::Connected)) => {
                connects += 1;
                if connects > 1 {
                    tlog!("{} reconnected", drain.label);
                }
            }
            Wake::Event(Some(TaskEvent::Batch(events))) => {
                for event in events {
                    drain.on_poll_event(event, &task).await;
                }
            }
            Wake::Event(Some(TaskEvent::Disconnected {
                error,
                consecutive,
                retry_in,
            })) => {
                if drain.gives_up_on_disconnect(&error, consecutive, retry_in) {
                    break;
                }
            }
        }
    }
    task.stop().await;
}

struct Drain {
    sink: FrameSink,
    label: String,
    max_register_errors: u32,
    throttle: SignalThrottle,
    first_poll: bool,
}

impl Drain {
    fn limit_text(&self) -> String {
        match self.max_register_errors {
            0 => "∞".to_string(),
            limit => limit.to_string(),
        }
    }

    async fn on_poll_event(&mut self, event: PollEvent<PollGroup>, task: &PollTask<PollGroup>) {
        let label = &self.label;
        match event {
            PollEvent::Read {
                tag: poll,
                reading,
                recovered,
                ..
            } => {
                let type_name = poll.register_type.catalog().as_str();
                if recovered {
                    tlog!(
                        "{} {} reg {} recovered, back to every {}ms",
                        label,
                        type_name,
                        poll.start_register,
                        poll.interval_ms
                    );
                }
                let frames = frames_for_read(&poll, reading.data, reading.at);
                if self.first_poll {
                    tlog!(
                        "{} first poll OK: {} reg {} → {} frame(s)",
                        label,
                        type_name,
                        poll.start_register,
                        frames.len()
                    );
                    self.first_poll = false;
                }
                self.sink.frames(frames, &mut self.throttle).await;
            }
            PollEvent::Exception {
                tag: poll,
                code,
                retry_in,
                ..
            } => {
                let type_name = poll.register_type.catalog().as_str();
                tlog!(
                    "{} error reading {} at {}: Modbus exception: {} (next read in {:?})",
                    label,
                    type_name,
                    poll.start_register,
                    code,
                    retry_in
                );
                self.sink.error(format!(
                    "Modbus read error ({} @ {}): Modbus exception: {}",
                    type_name, poll.start_register, code
                ));
            }
            PollEvent::Transport {
                item,
                tag: poll,
                error,
                consecutive,
                ..
            } => {
                let type_name = poll.register_type.catalog().as_str();
                tlog!(
                    "{} error reading {} at {}: IO error: {} ({}/{})",
                    label,
                    type_name,
                    poll.start_register,
                    error,
                    consecutive,
                    self.limit_text()
                );
                self.sink.error(format!(
                    "Modbus read error ({} @ {}): IO error: {}",
                    type_name, poll.start_register, error
                ));
                if exhausted(consecutive, self.max_register_errors) {
                    task.retire(item);
                    tlog!(
                        "{} stopped polling {} reg {} after {} consecutive errors",
                        label,
                        type_name,
                        poll.start_register,
                        consecutive
                    );
                    self.sink.error(format!(
                        "Stopped polling {} @ {} after {} consecutive errors",
                        type_name, poll.start_register, consecutive
                    ));
                }
            }
        }
    }

    fn gives_up_on_disconnect(
        &self,
        error: &TransportError,
        consecutive: u32,
        retry_in: Duration,
    ) -> bool {
        if exhausted(consecutive, self.max_register_errors) {
            tlog!(
                "{} stopped polling after {} failed connection attempts: {}",
                self.label,
                consecutive,
                error
            );
            self.sink.error(format!(
                "Stopped polling after {consecutive} failed connection attempts: {error}"
            ));
            return true;
        }
        tlog!(
            "{} disconnected: {} ({}/{}), reconnecting in {:?}",
            self.label,
            error,
            consecutive,
            self.limit_text(),
            retry_in
        );
        self.sink.error(format!("Modbus connection lost: {error}"));
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::RegisterType;

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
        let frames = frames_for_read(
            &p,
            ReadData::Registers(vec![0x1234, 0xABCD]),
            SystemTime::now(),
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].frame_id, 13007);
        assert_eq!(frames[0].bytes, vec![0x12, 0x34, 0xAB, 0xCD]);
        assert_eq!(frames[0].dlc, 4);
    }

    #[test]
    fn per_register_mode_keys_each_frame_by_its_address() {
        let p = poll(RegisterType::Holding, 100, 3, PollEmitMode::PerRegister);
        let frames = frames_for_read(
            &p,
            ReadData::Registers(vec![0x0001, 0xFFFF, 0x4D42]),
            SystemTime::now(),
        );
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
        let frames = frames_for_read(&p, ReadData::Registers(vec![1, 2]), SystemTime::now());
        assert!(frames.iter().all(|f| f.bus == 3));
    }

    #[test]
    fn per_register_coils_emit_one_byte_each() {
        let p = poll(RegisterType::Coil, 8, 3, PollEmitMode::PerRegister);
        let frames = frames_for_read(
            &p,
            ReadData::Coils(vec![true, false, true]),
            SystemTime::now(),
        );
        assert_eq!(
            frames.iter().map(|f| (f.frame_id, f.bytes.clone())).collect::<Vec<_>>(),
            vec![(8, vec![1]), (9, vec![0]), (10, vec![1])]
        );
    }

    #[test]
    fn block_coils_stay_packed_lsb_first() {
        let p = poll(RegisterType::Coil, 0, 3, PollEmitMode::Block);
        let frames = frames_for_read(
            &p,
            ReadData::Coils(vec![true, false, true]),
            SystemTime::now(),
        );
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
        let frames = frames_for_read(&p, ReadData::Coils(coils), SystemTime::now());
        assert_eq!(frames[0].bytes, vec![0x09, 0x01, 0x02]);

        let d = decode_by_id(&catalog, frames[0].frame_id, &frames[0].bytes).unwrap();
        let value = |n: &str| d.signals.iter().find(|s| s.name == n).unwrap().scaled;
        assert_eq!(value("Coil0"), 1.0);
        assert_eq!(value("Coil3"), 1.0);
        assert_eq!(value("Coil17"), 1.0);
        assert_eq!(value("Wide"), 131_337.0); // 0x020109, coils 0·3·8·17
    }

    #[test]
    fn every_frame_is_stamped_with_the_time_of_its_read() {
        let p = poll(RegisterType::Holding, 0, 2, PollEmitMode::PerRegister);
        let at = UNIX_EPOCH + Duration::from_micros(1_700_000_000_123_456);
        let frames = frames_for_read(&p, ReadData::Registers(vec![1, 2]), at);
        assert!(frames
            .iter()
            .all(|f| f.timestamp_us == 1_700_000_000_123_456));
    }

    #[test]
    fn a_run_of_failures_is_exhausted_at_the_limit_and_never_at_zero() {
        assert!(!exhausted(1, 2));
        assert!(exhausted(2, 2));
        assert!(exhausted(3, 2));
        assert!((1..10_000).all(|n| !exhausted(n, 0)));
    }

    use wiretap_io::modbus::testing::{self, device, Device, Reply};
    use tokio::time::timeout;

    fn holding(start: u16, count: u16) -> PollGroup {
        PollGroup {
            register_type: RegisterType::Holding,
            start_register: start,
            count,
            interval_ms: 1000,
            frame_id: 42,
            device_address: 1,
            emit_mode: PollEmitMode::Block,
        }
    }

    async fn spawn_on(device: &Device, polls: &[PollGroup]) -> PollTask<PollGroup> {
        let options = TcpOptions {
            op_timeout: Duration::from_millis(500),
            ..TcpOptions::default()
        };
        let mut conn = ModbusTcp::new(format!("127.0.0.1:{}", device.port), options);
        conn.connect().await.unwrap();
        let fast_reconnects = TaskOptions {
            reconnect_initial: Duration::from_millis(10),
            reconnect_max: Duration::from_millis(20),
            ..TaskOptions::default()
        };
        spawn_polls(conn, polls, fast_reconnects)
    }

    fn broker_sink() -> (FrameSink, mpsc::Receiver<SourceMessage>) {
        let (tx, rx) = mpsc::channel(64);
        (FrameSink::Broker { source_idx: 0, tx }, rx)
    }

    #[tokio::test]
    async fn a_read_becomes_frames_stamped_when_it_was_read_and_stop_ends_the_run() {
        let device = device(testing::registers).await;
        let task = spawn_on(&device, &[holding(5, 2)]).await;
        let (sink, mut frames) = broker_sink();
        let (control, control_rx) = watch::channel(PollControl::Run);
        let before = now_us();
        let run = tokio::spawn(run_poll_task(task, control_rx, sink, 1));

        let Some(SourceMessage::Frames(0, batch)) = frames.recv().await else {
            panic!("no frames");
        };
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].frame_id, 42);
        assert_eq!(batch[0].bytes, vec![0, 5, 0, 6]);
        assert!((before..=now_us()).contains(&batch[0].timestamp_us));

        control.send_replace(PollControl::Stop);
        timeout(Duration::from_secs(2), run)
            .await
            .expect("stop hung")
            .unwrap();
    }

    #[tokio::test]
    async fn a_group_that_keeps_losing_the_link_is_retired_at_the_limit() {
        let device = device(|request| match request.start() {
            1000 => Reply::Drop,
            _ => testing::registers(request),
        })
        .await;
        let task = spawn_on(&device, &[holding(1000, 1)]).await;
        let (sink, _frames) = broker_sink();
        let (_control, control_rx) = watch::channel(PollControl::Run);

        timeout(
            Duration::from_secs(2),
            run_poll_task(task, control_rx, sink, 2),
        )
        .await
        .expect("the last group retired but the run went on");
        let starts: Vec<u16> = device.requests().iter().map(|r| r.start()).collect();
        assert_eq!(starts, [1000, 1000]);
    }

    #[tokio::test]
    async fn an_unreachable_device_ends_the_run_at_the_limit() {
        let device = device(|_| Reply::Vanish).await;
        let task = spawn_on(&device, &[holding(0, 1)]).await;
        let (sink, _frames) = broker_sink();
        let (_control, control_rx) = watch::channel(PollControl::Run);

        timeout(
            Duration::from_secs(2),
            run_poll_task(task, control_rx, sink, 2),
        )
        .await
        .expect("the device was gone but the run went on");
    }

    #[tokio::test]
    async fn a_write_goes_over_the_poll_s_own_connection() {
        let device = device(testing::registers).await;
        let task = spawn_on(&device, &[holding(0, 1)]).await;
        let _registered = register_writer("write-session", "profile", task.writer());

        let writer = poll_writer("write-session", "profile").expect("no writer registered");
        let written = timeout(Duration::from_secs(2), writer.write_registers(None, 7, vec![42]))
            .await
            .expect("the write hung");
        assert!(matches!(written, Ok(Ok(_))), "{written:?}");

        let requests = device.requests();
        assert!(requests.iter().any(|r| r.function() == 0x06 && r.start() == 7));
        assert!(requests.iter().all(|r| r.connection == 1));
        task.stop().await;
    }

    #[tokio::test]
    async fn a_writer_is_reachable_only_while_its_poll_is_registered() {
        let device = device(testing::registers).await;
        let old = spawn_on(&device, &[holding(0, 1)]).await;
        let new = spawn_on(&device, &[holding(0, 1)]).await;

        let stale = register_writer("restarted", "profile", old.writer());
        let current = register_writer("restarted", "profile", new.writer());
        drop(stale);
        assert!(poll_writer("restarted", "profile").is_some());
        assert!(poll_writer("restarted", "other-profile").is_none());
        drop(current);
        assert!(poll_writer("restarted", "profile").is_none());
    }

    #[tokio::test]
    async fn a_limit_of_zero_keeps_reconnecting() {
        let device = device(|_| Reply::Vanish).await;
        let task = spawn_on(&device, &[holding(0, 1)]).await;
        let (sink, _frames) = broker_sink();
        let (_control, control_rx) = watch::channel(PollControl::Run);

        let run = run_poll_task(task, control_rx, sink, 0);
        assert!(timeout(Duration::from_millis(300), run).await.is_err());
    }
}

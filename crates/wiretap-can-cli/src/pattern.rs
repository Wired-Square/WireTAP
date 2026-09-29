use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use clap::ValueEnum;
use tokio::time::{timeout_at, Instant};
use wiretap_io::can::{CanEvent, CanFrame, CanTask, CanWriter, Direction};
use wiretap_protocol::{
    dlc_to_len,
    testpattern::{
        self as tp, capability, status_field, Command, Flags, Latencies, Message, Responder,
        SequenceTracker,
    },
};

const HELLO_ATTEMPTS: u32 = 3;
const HELLO_TIMEOUT: Duration = Duration::from_millis(500);
const SWEEP_TIMEOUT: Duration = Duration::from_millis(500);
const STATUS_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_CONSECUTIVE_FAILURES: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Mode {
    Echo,
    Sweep,
    Throughput,
    Latency,
    Reliability,
}

impl Mode {
    /// The mode byte a `Start` carries, as the app's initiator sends it.
    fn code(self) -> u8 {
        match self {
            Self::Echo => 1,
            Self::Sweep => 2,
            Self::Throughput => 3,
            Self::Latency => 4,
            Self::Reliability => 5,
        }
    }

    pub fn default_rate(self) -> f64 {
        match self {
            Self::Latency => 10.0,
            Self::Throughput => 0.0,
            _ => 100.0,
        }
    }
}

/// Where the Test Pattern exchange meets a bus.
pub trait Link {
    fn send(&mut self, frame: CanFrame) -> impl Future<Output = Result<(), String>>;
    /// The next frame received before `deadline`, or `None` once it passes.
    fn next_frame(
        &mut self,
        deadline: Instant,
    ) -> impl Future<Output = Result<Option<CanFrame>, String>>;
}

pub struct TaskLink {
    task: CanTask,
    writer: CanWriter,
    received: VecDeque<CanFrame>,
}

impl TaskLink {
    pub fn new(task: CanTask) -> Self {
        Self {
            writer: task.writer(),
            task,
            received: VecDeque::new(),
        }
    }

    pub async fn stop(self) {
        self.task.stop().await;
    }
}

impl Link for TaskLink {
    async fn send(&mut self, frame: CanFrame) -> Result<(), String> {
        crate::iface::send(&self.writer, frame).await
    }

    async fn next_frame(&mut self, deadline: Instant) -> Result<Option<CanFrame>, String> {
        loop {
            if let Some(frame) = self.received.pop_front() {
                return Ok(Some(frame));
            }
            match timeout_at(deadline, self.task.next_event()).await {
                Err(_) => return Ok(None),
                Ok(Some(CanEvent::Read(reads))) => self.received.extend(
                    reads
                        .into_iter()
                        .filter(|read| read.direction == Direction::Rx)
                        .map(|read| read.frame),
                ),
                Ok(Some(CanEvent::Connected(_))) => {}
                Ok(Some(CanEvent::Disconnected {
                    error, retry_in, ..
                })) => {
                    eprintln!("disconnected: {error}");
                    if retry_in.is_none() {
                        return Err(error.to_string());
                    }
                }
                Ok(None) => return Err("the CAN task ended".to_owned()),
            }
        }
    }
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

/// Answers an initiator until `until`, or for good with `None`.
pub async fn respond(
    link: &mut impl Link,
    bus: u8,
    fd: bool,
    until: Option<Instant>,
) -> Result<Responder, String> {
    let capabilities = capability::EXTENDED | if fd { capability::FD } else { 0 };
    let mut responder = Responder::new(capabilities, bus);
    let far = || Instant::now() + Duration::from_secs(3600);
    println!("listening on bus {bus}{}", if fd { ", CAN FD" } else { "" });
    loop {
        let deadline = until.unwrap_or_else(far);
        let Some(frame) = link.next_frame(deadline).await? else {
            if until.is_some() {
                return Ok(responder);
            }
            continue;
        };
        if !tp::is_test_pattern_frame(frame.arb_id) {
            continue;
        }
        let bound = responder.run();
        let replies = responder.on_frame(
            frame.arb_id,
            frame.extended,
            frame.fd,
            &frame.data,
            now_us(),
        );
        for reply in replies {
            let answer = CanFrame::data(
                bus,
                reply.arb_id,
                reply.extended,
                reply.fd,
                reply.fd,
                reply.data,
            );
            if let Err(e) = link.send(answer).await {
                eprintln!("reply not sent: {e}");
            }
        }
        match (bound, responder.run()) {
            (None, Some(run)) => println!("run {run} started"),
            (Some(run), None) => {
                println!(
                    "run {run} stopped: {}",
                    counters(&responder.sequence, responder.tx_count)
                );
                println!("listening");
            }
            _ => {}
        }
    }
}

pub fn counters(sequence: &SequenceTracker, tx: u64) -> String {
    format!(
        "rx {} tx {} drops {} duplicates {} out of order {}",
        sequence.rx_count, tx, sequence.drops, sequence.duplicates, sequence.out_of_order
    )
}

#[derive(Debug, Clone, Copy)]
pub struct InitiatorConfig {
    pub mode: Mode,
    pub duration: Duration,
    pub rate_hz: f64,
    pub bus: u8,
    pub fd: bool,
    pub extended: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct PeerInfo {
    pub fd: bool,
    pub extended: bool,
    pub bus: u8,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RemoteStats {
    pub rx: u32,
    pub tx: u32,
    pub drops: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct SweepRow {
    pub code: u8,
    pub expected_len: usize,
    pub received_len: Option<usize>,
    pub passed: bool,
}

#[derive(Debug)]
pub struct Outcome {
    pub mode: Mode,
    pub run: u8,
    pub peer: PeerInfo,
    pub tx: u64,
    pub sequence: SequenceTracker,
    pub latency: Option<tp::LatencyStats>,
    pub remote: Option<RemoteStats>,
    pub sweep: Vec<SweepRow>,
    pub errors: Vec<String>,
    pub elapsed: Duration,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        let s = &self.sequence;
        match self.mode {
            Mode::Sweep => !self.sweep.is_empty() && self.sweep.iter().all(|row| row.passed),
            Mode::Throughput => {
                self.tx > 0 && self.remote.is_some_and(|r| u64::from(r.rx) == self.tx)
            }
            _ => {
                self.tx > 0
                    && self.errors.is_empty()
                    && s.drops == 0
                    && s.duplicates == 0
                    && s.out_of_order == 0
            }
        }
    }

    pub fn report(&self) -> String {
        let mut lines = vec![
            format!(
                "mode {:?}, run {}, {:.1} s",
                self.mode,
                self.run,
                self.elapsed.as_secs_f64()
            )
            .to_lowercase(),
            format!(
                "peer bus {}, fd {}, extended {}",
                self.peer.bus, self.peer.fd, self.peer.extended
            ),
            counters(&self.sequence, self.tx),
        ];
        if let Some(l) = self.latency {
            lines.push(format!(
                "latency us min {} p50 {} p95 {} p99 {} max {} mean {} ({} samples)",
                l.min_us, l.p50_us, l.p95_us, l.p99_us, l.max_us, l.mean_us, l.count
            ));
        }
        if let Some(r) = self.remote {
            lines.push(format!(
                "remote rx {} tx {} drops {} fps {}",
                r.rx, r.tx, r.drops, r.fps
            ));
        }
        for row in &self.sweep {
            lines.push(format!(
                "sweep code {:2} len {:2}: {}",
                row.code,
                row.expected_len,
                match (row.passed, row.received_len) {
                    (true, _) => "ok".to_owned(),
                    (false, Some(got)) => format!("FAIL, echo had {got} bytes or other data"),
                    (false, None) => "FAIL, no echo".to_owned(),
                }
            ));
        }
        lines.extend(self.errors.iter().map(|e| format!("error: {e}")));
        lines.push(if self.passed() { "PASS" } else { "FAIL" }.to_owned());
        lines.join("\n")
    }
}

struct Initiator<'a, L: Link> {
    link: &'a mut L,
    config: InitiatorConfig,
    run: u8,
    tx: u64,
    sequence: SequenceTracker,
    sent_at: HashMap<u16, u64>,
    latency: Latencies,
    errors: Vec<String>,
}

/// Runs one exchange: `Hello`, `Start`, the mode's traffic, the responder's
/// counters, then `Stop`.
pub async fn initiate(link: &mut impl Link, config: InitiatorConfig) -> Result<Outcome, String> {
    let started = Instant::now();
    let mut initiator = Initiator {
        link,
        config,
        run: (now_us() % 16) as u8,
        tx: 0,
        sequence: SequenceTracker::new(),
        sent_at: HashMap::new(),
        latency: Latencies::new(),
        errors: Vec::new(),
    };
    let peer = initiator.say_hello().await?;
    if config.fd && !peer.fd {
        initiator
            .errors
            .push("the responder does not answer CAN FD".to_owned());
    }
    initiator
        .control(Command::Start {
            mode: config.mode.code(),
            run: initiator.run,
        })
        .await?;
    let sweep = if config.mode == Mode::Sweep {
        initiator.sweep().await?
    } else {
        initiator.stream().await?;
        Vec::new()
    };

    let s = &mut initiator.sequence;
    s.drops += initiator.sent_at.len() as u64;
    let one_reply_each = matches!(config.mode, Mode::Echo | Mode::Latency | Mode::Reliability);
    if one_reply_each && initiator.tx > s.rx_count {
        s.drops = s.drops.max(initiator.tx - s.rx_count);
    }
    let remote = initiator.remote_status().await?;
    initiator.control(Command::Stop).await?;
    Ok(Outcome {
        mode: config.mode,
        run: initiator.run,
        peer,
        tx: initiator.tx,
        latency: initiator.latency.stats(),
        sequence: initiator.sequence,
        remote,
        sweep,
        errors: initiator.errors,
        elapsed: started.elapsed(),
    })
}

impl<L: Link> Initiator<'_, L> {
    fn frame(&self, arb_id: u32, extended: bool, data: Vec<u8>) -> CanFrame {
        CanFrame::data(
            self.config.bus,
            arb_id,
            extended,
            self.config.fd,
            self.config.fd,
            data,
        )
    }

    fn message(&self, msg: Message) -> CanFrame {
        let id = msg.arb_id();
        let extended = self.config.extended;
        let id = if extended {
            tp::extended_id(id).expect("a framed id")
        } else {
            id
        };
        self.frame(
            id,
            extended,
            tp::encode(msg, Flags::new(self.config.bus, self.run)).to_vec(),
        )
    }

    async fn control(&mut self, c: Command) -> Result<(), String> {
        let frame = self.message(Message::Control(c));
        self.link.send(frame).await
    }

    async fn say_hello(&mut self) -> Result<PeerInfo, String> {
        for _ in 0..HELLO_ATTEMPTS {
            self.control(Command::Hello).await?;
            let deadline = Instant::now() + HELLO_TIMEOUT;
            while let Some(frame) = self.link.next_frame(deadline).await? {
                if let Some((Message::Control(Command::HelloReply { capabilities, bus }), _)) =
                    tp::decode(&frame.data)
                {
                    return Ok(PeerInfo {
                        fd: capabilities & capability::FD != 0,
                        extended: capabilities & capability::EXTENDED != 0,
                        bus,
                    });
                }
            }
        }
        Err("no responder answered Hello".to_owned())
    }

    async fn remote_status(&mut self) -> Result<Option<RemoteStats>, String> {
        self.control(Command::RequestStatus).await?;
        let mut remote = RemoteStats::default();
        let mut seen = 0u8;
        let deadline = Instant::now() + STATUS_TIMEOUT;
        while seen != 0x0F {
            let Some(frame) = self.link.next_frame(deadline).await? else {
                break;
            };
            if let Some((Message::Status { field, value }, flags)) = tp::decode(&frame.data) {
                if flags.run != self.run {
                    continue;
                }
                let (slot, bit) = match field {
                    status_field::RX_COUNT => (&mut remote.rx, 1),
                    status_field::TX_COUNT => (&mut remote.tx, 2),
                    status_field::DROPS => (&mut remote.drops, 4),
                    status_field::FPS => (&mut remote.fps, 8),
                    _ => continue,
                };
                *slot = value;
                seen |= bit;
            }
        }
        Ok((seen != 0).then_some(remote))
    }

    fn receive(&mut self, frame: &CanFrame) {
        let Some((msg, flags)) = tp::decode(&frame.data) else {
            return;
        };
        if flags.run != self.run {
            return;
        }
        let seq = match (self.config.mode, msg) {
            (Mode::Echo | Mode::Reliability, Message::PingReply { seq }) => seq,
            (Mode::Latency, Message::LatencyReply { seq, .. }) => seq,
            _ => return,
        };
        self.sequence.track(seq);
        if let Some(sent) = self.sent_at.remove(&seq) {
            self.latency.record(now_us().saturating_sub(sent));
        }
    }

    /// Sends at the rate until a drain period before the end, so the last
    /// replies have time to arrive.
    async fn stream(&mut self) -> Result<(), String> {
        let config = self.config;
        let start = Instant::now();
        let end = start + config.duration;
        let drain = if config.duration >= Duration::from_secs(3) {
            Duration::from_secs(1)
        } else {
            config.duration / 3
        };
        let send_until = end - drain;
        let interval = if config.rate_hz > 0.0 {
            Duration::from_secs_f64(1.0 / config.rate_hz)
        } else {
            Duration::ZERO
        };
        let mut next_send = start;
        let mut seq: u16 = 0;
        let mut failures = 0;
        loop {
            let now = Instant::now();
            if now >= end {
                return Ok(());
            }
            if now < send_until && now >= next_send {
                let msg = match config.mode {
                    Mode::Throughput => Message::Throughput {
                        seq,
                        pattern: tp::pattern::NONE,
                    },
                    Mode::Latency => {
                        let at = now_us();
                        self.sent_at.insert(seq, at);
                        Message::LatencyProbe {
                            seq,
                            ts_us: at as u32,
                        }
                    }
                    _ => Message::PingRequest { seq },
                };
                let frame = self.message(msg);
                match self.link.send(frame).await {
                    Ok(()) => {
                        self.tx += 1;
                        failures = 0;
                    }
                    Err(e) => {
                        self.sent_at.remove(&seq);
                        self.errors.push(format!("seq {seq}: {e}"));
                        failures += 1;
                        if failures >= MAX_CONSECUTIVE_FAILURES {
                            return Err(format!("{failures} sends in a row failed: {e}"));
                        }
                    }
                }
                seq = seq.wrapping_add(1);
                next_send = if interval.is_zero() {
                    now
                } else {
                    next_send + interval
                };
            }
            let wait = if now < send_until {
                next_send.min(send_until)
            } else {
                end
            };
            while let Some(frame) = self.link.next_frame(wait).await? {
                self.receive(&frame);
            }
        }
    }

    /// One request per length code, each waiting for its echo.
    async fn sweep(&mut self) -> Result<Vec<SweepRow>, String> {
        let fd = self.config.fd;
        let mut rows = Vec::new();
        for code in tp::sweep_codes(fd) {
            let mut row = SweepRow {
                code,
                expected_len: dlc_to_len(code, fd),
                received_len: None,
                passed: false,
            };
            let request = self.frame(
                tp::SWEEP_REQUEST_BASE + u32::from(code),
                false,
                tp::sweep_payload(code, fd),
            );
            match self.link.send(request).await {
                Ok(()) => {
                    self.tx += 1;
                    let deadline = Instant::now() + SWEEP_TIMEOUT;
                    while let Some(frame) = self.link.next_frame(deadline).await? {
                        if tp::sweep_code(frame.arb_id) == Some((code, true)) {
                            self.sequence.rx_count += 1;
                            row.received_len = Some(frame.data.len());
                            row.passed = tp::sweep_echo_matches(code, fd, &frame.data);
                            break;
                        }
                    }
                }
                Err(e) => self.errors.push(format!("sweep code {code}: {e}")),
            }
            rows.push(row);
        }
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bus with a responder on it, which can drop or garble its replies.
    struct Loop {
        responder: Responder,
        replies: VecDeque<CanFrame>,
        drop_every: Option<u64>,
        truncate_code: Option<u8>,
        seen: u64,
    }

    impl Loop {
        fn new(fd: bool) -> Self {
            Self {
                responder: Responder::new(
                    capability::EXTENDED | if fd { capability::FD } else { 0 },
                    0,
                ),
                replies: VecDeque::new(),
                drop_every: None,
                truncate_code: None,
                seen: 0,
            }
        }
    }

    impl Link for Loop {
        async fn send(&mut self, frame: CanFrame) -> Result<(), String> {
            self.seen += 1;
            if self.drop_every.is_some_and(|n| self.seen.is_multiple_of(n)) {
                return Ok(());
            }
            for reply in self.responder.on_frame(
                frame.arb_id,
                frame.extended,
                frame.fd,
                &frame.data,
                now_us(),
            ) {
                let mut data = reply.data;
                if tp::sweep_code(reply.arb_id)
                    .is_some_and(|(code, _)| Some(code) == self.truncate_code)
                {
                    data.pop();
                }
                self.replies.push_back(CanFrame::data(
                    0,
                    reply.arb_id,
                    reply.extended,
                    reply.fd,
                    reply.fd,
                    data,
                ));
            }
            Ok(())
        }

        async fn next_frame(&mut self, deadline: Instant) -> Result<Option<CanFrame>, String> {
            if let Some(frame) = self.replies.pop_front() {
                return Ok(Some(frame));
            }
            tokio::time::sleep_until(deadline).await;
            Ok(None)
        }
    }

    fn config(mode: Mode) -> InitiatorConfig {
        InitiatorConfig {
            mode,
            duration: Duration::from_millis(300),
            rate_hz: 1000.0,
            bus: 0,
            fd: false,
            extended: false,
        }
    }

    #[tokio::test]
    async fn an_echo_run_against_a_responder_passes() {
        let mut link = Loop::new(false);
        let outcome = initiate(&mut link, config(Mode::Echo)).await.unwrap();
        assert!(outcome.passed(), "{}", outcome.report());
        assert!(outcome.tx > 10);
        assert_eq!(outcome.sequence.rx_count, outcome.tx);
        let remote = outcome.remote.unwrap();
        assert_eq!(u64::from(remote.rx), outcome.tx);
        assert_eq!(link.responder.run(), None, "Stop ends the run");
    }

    #[tokio::test]
    async fn lost_replies_fail_the_run() {
        let mut link = Loop::new(false);
        link.drop_every = Some(7);
        let outcome = initiate(&mut link, config(Mode::Echo)).await.unwrap();
        assert!(!outcome.passed());
        assert!(outcome.sequence.drops > 0);
    }

    #[tokio::test]
    async fn latency_and_throughput_runs_pass() {
        for mode in [Mode::Latency, Mode::Throughput, Mode::Reliability] {
            let mut link = Loop::new(false);
            let outcome = initiate(&mut link, config(mode)).await.unwrap();
            assert!(outcome.passed(), "{}", outcome.report());
            if mode == Mode::Latency {
                assert_eq!(outcome.latency.unwrap().count, outcome.tx);
            }
        }
    }

    #[tokio::test]
    async fn an_extended_run_is_answered_on_extended_ids() {
        let mut link = Loop::new(false);
        let outcome = initiate(
            &mut link,
            InitiatorConfig {
                extended: true,
                ..config(Mode::Echo)
            },
        )
        .await
        .unwrap();
        assert!(outcome.passed(), "{}", outcome.report());
    }

    #[tokio::test]
    async fn an_fd_sweep_checks_every_length_code() {
        let mut link = Loop::new(true);
        let outcome = initiate(
            &mut link,
            InitiatorConfig {
                fd: true,
                ..config(Mode::Sweep)
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome.sweep.len(), 16);
        assert!(outcome.passed(), "{}", outcome.report());

        let mut link = Loop::new(true);
        link.truncate_code = Some(9);
        let outcome = initiate(
            &mut link,
            InitiatorConfig {
                fd: true,
                ..config(Mode::Sweep)
            },
        )
        .await
        .unwrap();
        let failed: Vec<_> = outcome.sweep.iter().filter(|r| !r.passed).collect();
        assert_eq!(failed.len(), 1);
        assert_eq!((failed[0].code, failed[0].received_len), (9, Some(11)));
        assert!(!outcome.passed());
    }

    #[tokio::test]
    async fn a_silent_bus_has_no_peer() {
        struct Silent;
        impl Link for Silent {
            async fn send(&mut self, _: CanFrame) -> Result<(), String> {
                Ok(())
            }
            async fn next_frame(&mut self, deadline: Instant) -> Result<Option<CanFrame>, String> {
                tokio::time::sleep_until(deadline).await;
                Ok(None)
            }
        }
        let error = initiate(&mut Silent, config(Mode::Echo)).await.unwrap_err();
        assert!(error.contains("Hello"), "{error}");
    }

    #[tokio::test]
    async fn a_responder_answers_a_run_and_stops_at_its_deadline() {
        struct Script {
            incoming: VecDeque<CanFrame>,
            sent: Vec<CanFrame>,
        }
        impl Link for Script {
            async fn send(&mut self, frame: CanFrame) -> Result<(), String> {
                self.sent.push(frame);
                Ok(())
            }
            async fn next_frame(&mut self, deadline: Instant) -> Result<Option<CanFrame>, String> {
                if let Some(frame) = self.incoming.pop_front() {
                    return Ok(Some(frame));
                }
                tokio::time::sleep_until(deadline).await;
                Ok(None)
            }
        }
        let framed = |msg: Message| {
            CanFrame::data(
                0,
                msg.arb_id(),
                false,
                false,
                false,
                tp::encode(msg, Flags::new(0, 3)).to_vec(),
            )
        };
        let mut link = Script {
            incoming: [
                framed(Message::Control(Command::Hello)),
                framed(Message::Control(Command::Start { mode: 1, run: 3 })),
                framed(Message::PingRequest { seq: 0 }),
                CanFrame::data(0, 0x123, false, false, false, vec![1]),
                framed(Message::PingRequest { seq: 1 }),
                framed(Message::Control(Command::Stop)),
            ]
            .into(),
            sent: Vec::new(),
        };
        let until = Some(Instant::now() + Duration::from_millis(50));
        let responder = respond(&mut link, 0, false, until).await.unwrap();
        assert_eq!(responder.run(), None);
        assert_eq!(responder.sequence.rx_count, 2);
        let ids: Vec<_> = link.sent.iter().map(|f| f.arb_id).collect();
        assert_eq!(ids, [tp::ID_CONTROL, tp::ID_PING_REPLY, tp::ID_PING_REPLY]);
    }
}

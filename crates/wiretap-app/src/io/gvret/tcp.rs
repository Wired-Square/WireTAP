// ui/crates/wiretap-app/src/io/gvret/tcp.rs
//
// GVRET over TCP: the desktop's probe, and the session's source on
// `wiretap_io::can::gvret`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use wiretap_io::can::gvret::{open as open_gvret, GvretOptions, Link};
use wiretap_io::can::{CanError, CanEvent, CanOptions, ResolveError, TransportError};

use super::common::{
    absorb_num_buses_reply, clamp_bus_count, mappings_from_num_buses, GvretDeviceInfo,
    NumBusesOutcome,
};
use crate::io::bus_mapping::{apply_bus_mappings_batch, BusMapping};
use crate::io::can_task::{forward_transmits, frame_message};
use crate::io::error::IoError;
use crate::io::net::tcp_endpoint;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use wiretap_protocol::gvret;

/// Ask a connected device how many buses it has.
///
/// Frames read while waiting are collected into `pending` rather than discarded
/// — a device that is already streaming will interleave them with the reply,
/// and dropping them would lose traffic the session is meant to capture. They
/// are still unmapped: this exchange is what decides the mapping.
///
/// Generic over the halves so the probe, which has a borrowed split rather than
/// an owned one, asks the question the same way the streaming path does.
async fn query_num_buses<W: AsyncWrite + Unpin, R: AsyncRead + Unpin>(
    write_half: &mut W,
    read_half: &mut R,
    decoder: &mut gvret::DeviceDecoder,
    pending: &mut Vec<crate::io::FrameMessage>,
    timeout: Duration,
) -> NumBusesOutcome {
    if let Err(e) = write_half.write_all(&gvret::REQ_NUM_BUSES).await {
        return NumBusesOutcome::Failed(e.to_string());
    }
    let _ = write_half.flush().await;

    let read = async {
        let mut read_buf = [0u8; 2048];
        loop {
            match read_half.read(&mut read_buf).await {
                Ok(0) => return NumBusesOutcome::Closed,
                Err(e) => return NumBusesOutcome::Failed(e.to_string()),
                Ok(n) => {
                    if let Some(count) = absorb_num_buses_reply(decoder, &read_buf[..n], pending) {
                        return NumBusesOutcome::Answered(count);
                    }
                }
            }
        }
    };

    tokio::time::timeout(timeout, read)
        .await
        .unwrap_or(NumBusesOutcome::Silent)
}

// ============================================================================
// Device Probing
// ============================================================================

/// Probe a GVRET TCP device to discover its capabilities
///
/// This function connects to the device, queries the number of available buses,
/// and returns device information. The connection is closed after probing.
///
/// The device label both the probe and the streaming path identify themselves by.
fn gvret_tcp_device(host: &str, port: u16) -> String {
    format!("gvret_tcp({}:{})", host, port)
}

/// Resolve, then connect within `timeout_sec`.
///
/// Resolving separately is what keeps a DNS failure distinguishable from an
/// unreachable host — see [`crate::io::net::resolve_host_port`]. Shared by the probe
/// and the streaming path so the two cannot drift in how they classify or label a
/// connect failure; they previously reported the same failure differently.
async fn connect_gvret_tcp(host: &str, port: u16, timeout_sec: f64) -> Result<TcpStream, IoError> {
    let addr = crate::io::net::resolve_host_port(host, port).await?;

    match tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(IoError::connection(
            gvret_tcp_device(host, port),
            e.to_string(),
        )),
        Err(_) => Err(IoError::timeout(gvret_tcp_device(host, port), "connect")),
    }
}

/// Returns `IoError` for typed error handling. Use `.map_err(String::from)` if
/// you need a String error for backwards compatibility.
pub async fn probe_gvret_tcp(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<GvretDeviceInfo, IoError> {
    tlog!(
        "[probe_gvret_tcp] Probing GVRET device at {}:{} (timeout: {}s)",
        host,
        port,
        timeout_sec
    );

    let device = gvret_tcp_device(host, port);

    let mut stream = connect_gvret_tcp(host, port, timeout_sec).await?;
    tlog!("[probe_gvret_tcp] Connected to {}:{}", host, port);

    // Enter binary mode
    stream
        .write_all(&gvret::SYNC)
        .await
        .map_err(|e| IoError::protocol(&device, format!("enable binary mode: {}", e)))?;

    // Wait a moment for the device to process
    tokio::time::sleep(Duration::from_millis(50)).await;

    let read_timeout = Duration::from_millis((timeout_sec * 1000.0) as u64);
    let (mut read_half, mut write_half) = stream.split();
    let mut decoder = gvret::DeviceDecoder::new();
    let outcome = query_num_buses(
        &mut write_half,
        &mut read_half,
        &mut decoder,
        &mut Vec::new(),
        read_timeout,
    )
    .await;

    match outcome {
        NumBusesOutcome::Answered(bus_count) => {
            tlog!(
                "[probe_gvret_tcp] SUCCESS: Device at {}:{} has {} buses available",
                host,
                port,
                bus_count
            );
            Ok(GvretDeviceInfo { bus_count })
        }
        NumBusesOutcome::Failed(e) => Err(IoError::read(&device, e)),
        // A probe reports what it can rather than refusing: a device that never
        // answers is still worth adding as single-bus, which is what the picker
        // has always shown. The streaming path is where the distinction between
        // quiet and dead has to be made, because that is where it costs traffic.
        NumBusesOutcome::Closed | NumBusesOutcome::Silent => {
            tlog!("[probe_gvret_tcp] No NUMBUSES response received, defaulting to 1 bus");
            Ok(GvretDeviceInfo { bus_count: 1 })
        }
    }
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

const STOP_POLL: Duration = Duration::from_millis(50);

/// Worded as `resolve_host_port` and the probe word a failed connect.
fn connect_failed(host: &str, device: &str, error: TransportError) -> IoError {
    match error {
        TransportError::Resolve { reason, .. } => IoError::dns_resolution(
            host,
            match reason {
                ResolveError::NoAddresses => "the name resolved to no addresses".to_string(),
                ResolveError::TimedOut => "the DNS resolver did not respond".to_string(),
                ResolveError::Io(e) => e.to_string(),
            },
        ),
        TransportError::ConnectTimeout { .. } | TransportError::Timeout { .. } => {
            IoError::timeout(device, "connect")
        }
        other => IoError::connection(device, other.to_string()),
    }
}

/// A link lost during the handshake reads as it did when the desktop asked
/// GET_NUMBUSES itself.
fn open_failed(host: &str, device: &str, error: CanError) -> String {
    let outcome = match error {
        CanError::Connect(e) => return connect_failed(host, device, e).user_message(),
        CanError::Closed => NumBusesOutcome::Closed,
        CanError::Read(e) => NumBusesOutcome::Failed(e.to_string()),
        other => return format!("{device}: {other}"),
    };
    mappings_from_num_buses(outcome, &[], device)
        .err()
        .unwrap_or_default()
}

/// A closed link ends the source as disconnected; any other loss, an
/// unanswered keepalive included, is an error.
fn link_lost(source_idx: usize, device: &str, error: CanError) -> SourceMessage {
    match error {
        CanError::Closed => SourceMessage::Ended(source_idx, EndReason::Disconnected),
        other => SourceMessage::Error(source_idx, format!("{device}: {other}")),
    }
}

struct Stream {
    source_idx: usize,
    device: String,
    address: String,
    profile_mappings: Vec<BusMapping>,
    mappings: Vec<BusMapping>,
}

impl Stream {
    /// What the broker is told of `event`, or the loss that ends the source.
    fn on_event(&mut self, event: CanEvent) -> Result<Vec<SourceMessage>, CanError> {
        match event {
            CanEvent::Connected(info) => {
                if !info.keepalive {
                    tlog!(
                        "[gvret_tcp] {} does not answer keepalives, so a silent drop will not be seen",
                        self.device
                    );
                }
                let outcome = info.buses.map_or(NumBusesOutcome::Silent, |n| {
                    NumBusesOutcome::Answered(clamp_bus_count(n))
                });
                if let Ok(mappings) =
                    mappings_from_num_buses(outcome, &self.profile_mappings, &self.device)
                {
                    self.mappings = mappings;
                }
                Ok(vec![
                    SourceMessage::MappingsResolved(self.source_idx, self.mappings.clone()),
                    SourceMessage::Connected(
                        self.source_idx,
                        "gvret_tcp".to_string(),
                        self.address.clone(),
                        None,
                    ),
                ])
            }
            CanEvent::Read(reads) => {
                let frames = apply_bus_mappings_batch(
                    reads.into_iter().map(frame_message).collect(),
                    &self.mappings,
                );
                Ok(if frames.is_empty() {
                    Vec::new()
                } else {
                    vec![SourceMessage::Frames(self.source_idx, frames)]
                })
            }
            CanEvent::Disconnected { error, .. } => Err(error),
        }
    }
}

/// Run GVRET TCP source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    host: String,
    port: u16,
    timeout_sec: f64,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = gvret_tcp_device(&host, port);
    let link = Link::Tcp {
        endpoint: tcp_endpoint(&host, port),
        connect_timeout: Duration::from_secs_f64(timeout_sec),
    };
    let mut options = CanOptions::default();
    options.reopen = None;
    let mut task = match open_gvret(link, GvretOptions::default(), options).await {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    open_failed(&host, &device, e),
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

    let mut stream = Stream {
        source_idx,
        device,
        address: format!("{}:{}", host, port),
        mappings: bus_mappings.clone(),
        profile_mappings: bus_mappings,
    };
    let mut poll = tokio::time::interval(STOP_POLL);
    let lost = loop {
        tokio::select! {
            event = task.next_event() => {
                let Some(event) = event else { break Some(CanError::Closed) };
                match stream.on_event(event) {
                    Ok(messages) => {
                        for message in messages {
                            let _ = tx.send(message).await;
                        }
                    }
                    Err(error) => break Some(error),
                }
            }
            _ = poll.tick() => {
                if stop_flag.load(Ordering::SeqCst) {
                    break None;
                }
            }
        }
    };

    let ended = match lost {
        Some(error) => link_lost(source_idx, &stream.device, error),
        None => {
            task.stop().await;
            SourceMessage::Ended(source_idx, EndReason::Stopped)
        }
    };
    let _ = tx.send(ended).await;
}

#[cfg(test)]
mod tests {
    use super::super::common::{MAX_BUSES, NUMBUSES_TIMEOUT};
    use super::*;
    use std::time::UNIX_EPOCH;
    use tokio::net::TcpListener;
    use tokio::time::timeout;
    use wiretap_io::can::{CanFrame, CanRead, DeviceInfo, Direction};
    use wiretap_protocol::gvret::ClientCommand;

    /// Serve one connection, handing it to `serve`, and ask the listener what
    /// `query_num_buses` made of it.
    async fn outcome_against<F, Fut>(serve: F) -> NumBusesOutcome
    where
        F: FnOnce(TcpStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            serve(sock).await;
        });

        let stream = TcpStream::connect(addr).await.expect("connect");
        let (mut read_half, mut write_half) = stream.into_split();
        query_num_buses(
            &mut write_half,
            &mut read_half,
            &mut gvret::DeviceDecoder::new(),
            &mut Vec::new(),
            NUMBUSES_TIMEOUT,
        )
        .await
    }

    #[tokio::test]
    async fn a_device_that_answers_reports_its_bus_count() {
        let outcome = outcome_against(|mut sock| async move {
            let _ = sock.write_all(&gvret::encode_num_buses(2)).await;
            // Hold the connection open so the reply is not also a close.
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Answered(2)),
            "got {outcome:?}"
        );
    }

    /// The reported failure: an SSH tunnel accepts locally while nothing serves
    /// the far end, so the peer goes away before any command is answered. This
    /// must not read as a device that ignores GET_NUMBUSES.
    ///
    /// A peer that drops the socket with our command still unread resets it, so
    /// this arrives as an error rather than a clean end-of-stream — the two
    /// halves of "there is no device there" are split across `Failed` and
    /// `Closed` by whether the far end drained us first, not by anything the
    /// user did. Both are immediate and both name the connection.
    #[tokio::test]
    async fn a_peer_that_vanishes_on_connect_is_not_a_silent_device() {
        let outcome = outcome_against(|sock| async move { drop(sock) }).await;
        assert!(
            matches!(outcome, NumBusesOutcome::Failed(_)),
            "got {outcome:?}"
        );
    }

    /// The same situation where the far end reads before hanging up: a clean
    /// end-of-stream rather than a reset.
    #[tokio::test]
    async fn a_peer_that_closes_cleanly_is_not_a_silent_device() {
        let outcome = outcome_against(|mut sock| async move {
            let mut sink = [0u8; 8];
            let _ = sock.read(&mut sink).await;
            let _ = sock.shutdown().await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Closed),
            "got {outcome:?}"
        );
    }

    /// A GVRET-compatible bridge that does not implement GET_NUMBUSES holds the
    /// connection open and says nothing. That is the one case worth waiting for.
    #[tokio::test]
    async fn a_live_but_quiet_link_is_silent_not_closed() {
        let outcome = outcome_against(|sock| async move {
            tokio::time::sleep(NUMBUSES_TIMEOUT + Duration::from_millis(500)).await;
            drop(sock);
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Silent),
            "got {outcome:?}"
        );
    }

    // --- the source on wiretap_io --------------------------------------------

    const DEVICE: &str = "gvret_tcp(10.0.0.9:23)";

    fn mapping(device_bus: u8, enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus,
            enabled,
            output_bus,
            ..BusMapping::default()
        }
    }

    fn stream(profile_mappings: Vec<BusMapping>) -> Stream {
        Stream {
            source_idx: 3,
            device: DEVICE.to_string(),
            address: "10.0.0.9:23".to_string(),
            mappings: profile_mappings.clone(),
            profile_mappings,
        }
    }

    fn connected(buses: Option<u8>) -> CanEvent {
        let mut info = DeviceInfo::default();
        info.buses = buses;
        info.keepalive = true;
        CanEvent::Connected(info)
    }

    fn resolved(messages: &[SourceMessage]) -> &[BusMapping] {
        match messages {
            [SourceMessage::MappingsResolved(3, mappings), SourceMessage::Connected(3, kind, address, None)] =>
            {
                assert_eq!(
                    (kind.as_str(), address.as_str()),
                    ("gvret_tcp", "10.0.0.9:23")
                );
                mappings
            }
            _ => panic!("expected MappingsResolved then Connected"),
        }
    }

    #[test]
    fn a_connect_reconciles_the_profile_to_the_reported_bus_count() {
        let mut s = stream(vec![mapping(0, true, 0)]);
        let messages = s.on_event(connected(Some(2))).unwrap();
        let mappings = resolved(&messages);
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[1].device_bus, 1);
    }

    #[test]
    fn an_implausible_bus_count_is_clamped() {
        let mut s = stream(vec![mapping(0, true, 0)]);
        let messages = s.on_event(connected(Some(0))).unwrap();
        assert_eq!(resolved(&messages).len(), MAX_BUSES as usize);
    }

    #[test]
    fn a_device_that_never_says_keeps_the_profiles_buses() {
        let mut s = stream(vec![mapping(2, true, 5)]);
        let messages = s.on_event(connected(None)).unwrap();
        let mappings = resolved(&messages);
        assert_eq!(mappings.len(), 1);
        assert_eq!((mappings[0].device_bus, mappings[0].output_bus), (2, 5));
    }

    #[test]
    fn a_read_is_mapped_onto_the_sessions_buses() {
        let mut s = stream(vec![mapping(0, true, 7), mapping(1, false, 1)]);
        let read = |bus, at_us| CanRead {
            frame: CanFrame::data(bus, 0x100, false, false, false, vec![bus]),
            direction: Direction::Rx,
            at: UNIX_EPOCH + Duration::from_micros(at_us),
            device_us: Some(at_us),
        };
        let messages = s
            .on_event(CanEvent::Read(vec![read(0, 10), read(1, 20)]))
            .unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        assert_eq!(frames.len(), 1, "the muted bus is dropped");
        assert_eq!((frames[0].bus, frames[0].timestamp_us), (7, 10));

        let muted = s.on_event(CanEvent::Read(vec![read(1, 30)])).unwrap();
        assert!(muted.is_empty(), "no empty Frames");
    }

    #[test]
    fn a_loss_ends_the_stream_with_its_kind() {
        let mut s = stream(vec![]);
        let lost = s.on_event(CanEvent::Disconnected {
            error: CanError::Unresponsive,
            consecutive: 1,
            retry_in: None,
        });
        assert!(matches!(lost, Err(CanError::Unresponsive)));
    }

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

    #[test]
    fn a_failed_open_says_what_failed() {
        let closed = open_failed("10.0.0.9", DEVICE, CanError::Closed);
        assert!(closed.contains("closed the connection"), "got: {closed}");
        let reset = open_failed(
            "10.0.0.9",
            DEVICE,
            CanError::Read(std::io::Error::other("connection reset")),
        );
        assert!(reset.contains("connection reset"), "got: {reset}");
        let dns = open_failed(
            "gvret.invalid",
            DEVICE,
            CanError::Connect(TransportError::Resolve {
                endpoint: "gvret.invalid:23".into(),
                reason: ResolveError::NoAddresses,
            }),
        );
        assert!(
            dns.starts_with("Cannot resolve the hostname gvret.invalid"),
            "got: {dns}"
        );
        let slow = open_failed(
            "10.0.0.9",
            DEVICE,
            CanError::Connect(TransportError::ConnectTimeout {
                addr: "10.0.0.9:23".parse().unwrap(),
                after: Duration::from_secs(1),
            }),
        );
        assert_eq!(slow, IoError::timeout(DEVICE, "connect").user_message());
    }

    // --- against a fake device on 127.0.0.1 ------------------------------------

    fn wire_frame(ts_us: u32, arb_id: u32, bus: u8) -> Vec<u8> {
        gvret::encode_frame(ts_us, arb_id, false, bus, &[bus, 0xAA], false)
    }

    /// A two-bus GVRET device built from the protocol crate's own device end. It
    /// answers `keepalives` keepalives, sends a frame with its bus count, then
    /// three frames 10 ms and 20 ms apart by its clock, and passes on every
    /// command it hears. With `hang_up` it closes its end after them.
    async fn fake_gvret(
        keepalives: usize,
        hang_up: bool,
    ) -> (u16, mpsc::UnboundedReceiver<ClientCommand>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (heard, commands) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut decoder = gvret::Decoder::new();
            let mut keepalives = keepalives;
            let mut buf = [0u8; 1024];
            loop {
                let n = match sock.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                for command in decoder.feed(&buf[..n]) {
                    let reply = match command {
                        ClientCommand::DevInfo => gvret::encode_dev_info(),
                        ClientCommand::Keepalive if keepalives > 0 => {
                            keepalives -= 1;
                            gvret::encode_keepalive()
                        }
                        ClientCommand::NumBuses => {
                            [wire_frame(0, 0x100, 0), gvret::encode_num_buses(2)].concat()
                        }
                        _ => Vec::new(),
                    };
                    let _ = sock.write_all(&reply).await;
                    if command == ClientCommand::NumBuses {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let burst = [
                            wire_frame(1_000_000, 0x200, 0),
                            wire_frame(1_010_000, 0x201, 1),
                            wire_frame(1_030_000, 0x202, 0),
                        ]
                        .concat();
                        let _ = sock.write_all(&burst).await;
                        if hang_up {
                            let _ = sock.shutdown().await;
                        }
                    }
                    let _ = heard.send(command);
                }
            }
        });
        (port, commands)
    }

    fn start(port: u16) -> (Arc<AtomicBool>, mpsc::Receiver<SourceMessage>) {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(run_source(
            3,
            "127.0.0.1".to_string(),
            port,
            2.0,
            vec![mapping(0, true, 0)],
            stop.clone(),
            tx,
        ));
        (stop, rx)
    }

    async fn next(rx: &mut mpsc::Receiver<SourceMessage>, within: Duration) -> SourceMessage {
        timeout(within, rx.recv())
            .await
            .expect("the source went quiet")
            .expect("the source hung up")
    }

    /// Everything up to and including the four frames: the one sent with the
    /// bus count, then the burst.
    async fn connect_and_read(
        rx: &mut mpsc::Receiver<SourceMessage>,
    ) -> (
        crate::io::types::TransmitSender,
        Vec<crate::io::FrameMessage>,
    ) {
        let within = Duration::from_secs(3);
        let SourceMessage::TransmitReady(3, transmit) = next(rx, within).await else {
            panic!("expected TransmitReady first");
        };
        let SourceMessage::MappingsResolved(3, mappings) = next(rx, within).await else {
            panic!("expected MappingsResolved");
        };
        assert_eq!(mappings.len(), 2, "the device's two buses");
        assert!(matches!(
            next(rx, within).await,
            SourceMessage::Connected(3, ..)
        ));
        let mut frames = Vec::new();
        while frames.len() < 4 {
            let SourceMessage::Frames(3, read) = next(rx, within).await else {
                panic!("expected Frames");
            };
            frames.extend(read);
        }
        (transmit, frames)
    }

    fn send(
        transmit: &crate::io::types::TransmitSender,
        frame: CanFrame,
    ) -> std_mpsc::Receiver<Result<(), String>> {
        let (result_tx, result) = std_mpsc::sync_channel(1);
        transmit
            .try_send(TransmitRequest {
                data: Vec::new(),
                frame: Some(frame),
                result_tx,
            })
            .expect("queued");
        result
    }

    async fn answer(result: std_mpsc::Receiver<Result<(), String>>) -> Result<(), String> {
        tokio::task::spawn_blocking(move || result.recv_timeout(Duration::from_secs(2)))
            .await
            .unwrap()
            .expect("the send was answered")
    }

    #[tokio::test]
    async fn a_gvret_device_streams_in_its_own_time_and_takes_a_transmit() {
        let (port, mut commands) = fake_gvret(usize::MAX, false).await;
        let (stop, mut rx) = start(port);
        let (transmit, frames) = connect_and_read(&mut rx).await;

        let ids: Vec<u32> = frames.iter().map(|f| f.frame_id).collect();
        assert_eq!(
            ids,
            [0x100, 0x200, 0x201, 0x202],
            "the handshake's frame is kept"
        );
        assert_eq!(frames[2].bus, 1);
        let burst: Vec<u64> = frames[1..].iter().map(|f| f.timestamp_us).collect();
        assert_eq!(
            [burst[1] - burst[0], burst[2] - burst[1]],
            [10_000, 20_000],
            "spaced by the device's clock, not by arrival"
        );

        let sent = CanFrame::data(1, 0x321, false, false, false, vec![1, 2, 3]);
        assert_eq!(answer(send(&transmit, sent)).await, Ok(()));
        let transmitted = timeout(Duration::from_secs(2), async {
            loop {
                if let Some(ClientCommand::Transmit {
                    bus,
                    arb_id,
                    extended,
                    data,
                }) = commands.recv().await
                {
                    return (bus, arb_id, extended, data);
                }
            }
        })
        .await
        .expect("the device heard the transmit");
        assert_eq!(transmitted, (1, 0x321, false, vec![1, 2, 3]));

        let fd = CanFrame::data(0, 0x321, false, true, false, vec![0; 12]);
        assert_eq!(
            answer(send(&transmit, fd)).await,
            Err("Transmit refused: 12 bytes is too long".to_string())
        );

        stop.store(true, Ordering::SeqCst);
        assert!(matches!(
            next(&mut rx, Duration::from_secs(2)).await,
            SourceMessage::Ended(3, EndReason::Stopped)
        ));
    }

    #[tokio::test]
    async fn a_device_that_stops_answering_ends_the_session() {
        let (port, _commands) = fake_gvret(1, false).await;
        let (_stop, mut rx) = start(port);
        connect_and_read(&mut rx).await;
        let SourceMessage::Error(3, error) = next(&mut rx, Duration::from_secs(5)).await else {
            panic!("expected an error");
        };
        assert!(error.ends_with("device stopped answering"), "got: {error}");
    }

    #[tokio::test]
    async fn a_device_that_hangs_up_is_a_disconnect() {
        let (port, _commands) = fake_gvret(usize::MAX, true).await;
        let (_stop, mut rx) = start(port);
        connect_and_read(&mut rx).await;
        assert!(matches!(
            next(&mut rx, Duration::from_secs(3)).await,
            SourceMessage::Ended(3, EndReason::Disconnected)
        ));
    }
}

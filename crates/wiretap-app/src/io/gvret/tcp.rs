// ui/crates/wiretap-app/src/io/gvret/tcp.rs
//
// GVRET over TCP: the desktop's probe, and the session's source on
// `wiretap_io::can::gvret`.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use wiretap_io::can::gvret::{open as open_gvret, probe, GvretOptions, Link};
use wiretap_io::can::{CanError, ResolveError, TransportError};

use super::common::{handshake_failed, probed_bus_count, GvretDeviceInfo, Stream};
use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{can_options, link_lost, serve};
use crate::io::error::IoError;
use crate::io::net::tcp_endpoint;
use crate::io::types::SourceMessage;

/// The device label both the probe and the streaming path identify themselves by.
fn gvret_tcp_device(host: &str, port: u16) -> String {
    format!("gvret_tcp({}:{})", host, port)
}

fn tcp_link(host: &str, port: u16, connect_timeout: Duration) -> Link {
    Link::Tcp {
        endpoint: tcp_endpoint(host, port),
        connect_timeout,
    }
}

/// Connects and asks the bus count, all within `timeout_sec`.
pub async fn probe_gvret_tcp(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<GvretDeviceInfo, String> {
    let timeout = Duration::from_secs_f64(timeout_sec);
    probed_bus_count(probe(tcp_link(host, port, timeout), timeout).await)
        .map_err(|e| open_failed(host, &gvret_tcp_device(host, port), e))
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

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

fn open_failed(host: &str, device: &str, error: CanError) -> String {
    match error {
        CanError::Connect(e) => connect_failed(host, device, e).user_message(),
        other => handshake_failed(device, other),
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
    let link = tcp_link(&host, port, Duration::from_secs_f64(timeout_sec));
    let task = match open_gvret(link, GvretOptions::default(), can_options(false, None)).await {
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

    let address = format!("{}:{}", host, port);
    let mut stream = Stream::new(
        source_idx,
        "gvret_tcp",
        device.clone(),
        address,
        bus_mappings,
    );
    serve(
        task,
        source_idx,
        false,
        &stop_flag,
        &tx,
        |event| stream.on_event(event),
        |error| link_lost(source_idx, &device, error),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::can_task::PortOutage;
    use crate::io::types::{EndReason, TransmitRequest};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc as std_mpsc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;
    use wiretap_io::can::CanFrame;
    use wiretap_protocol::gvret::{self, ClientCommand};

    const DEVICE: &str = "gvret_tcp(10.0.0.9:23)";

    fn mapping(device_bus: u8, enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus,
            enabled,
            output_bus,
            ..BusMapping::default()
        }
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

    /// A two-bus GVRET device built from the protocol crate's own device end. On
    /// each connection it answers `keepalives` keepalives, sends a frame with its
    /// bus count, then three frames 10 ms and 20 ms apart by its clock, and
    /// passes on every command it hears. With `hang_up` it closes its end after
    /// them.
    async fn fake_gvret(
        keepalives: usize,
        hang_up: bool,
    ) -> (u16, mpsc::UnboundedReceiver<ClientCommand>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (heard, commands) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut decoder = gvret::Decoder::new();
                let mut keepalives = keepalives;
                let mut buf = [0u8; 1024];
                loop {
                    let n = match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
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
                    ..
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
    async fn a_probe_reads_the_bus_count() {
        let (port, _commands) = fake_gvret(0, false).await;
        let info = probe_gvret_tcp("127.0.0.1", port, 2.0)
            .await
            .expect("probed");
        assert_eq!(info.bus_count, 2);
    }

    #[tokio::test]
    async fn a_probe_that_cannot_connect_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let error = probe_gvret_tcp("127.0.0.1", port, 2.0)
            .await
            .expect_err("refused");
        assert!(error.contains("127.0.0.1"), "got: {error}");
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

    #[tokio::test]
    async fn a_listen_only_source_is_offered_no_transmit() {
        let (port, _commands) = fake_gvret(usize::MAX, false).await;
        let link = Link::Tcp {
            endpoint: format!("127.0.0.1:{port}"),
            connect_timeout: Duration::from_secs(2),
        };
        let task = open_gvret(link, GvretOptions::default(), can_options(true, None))
            .await
            .expect("open");
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = mpsc::channel(64);
        let flag = stop.clone();
        tokio::spawn(async move {
            let mut stream = Stream::new(3, "gvret_tcp", DEVICE.into(), "here".into(), vec![]);
            let on_event = |event| stream.on_event(event);
            serve(task, 3, true, &flag, &tx, on_event, |_| panic!("not lost")).await
        });
        let within = Duration::from_secs(3);
        assert!(matches!(
            next(&mut rx, within).await,
            SourceMessage::MappingsResolved(3, _)
        ));
        stop.store(true, Ordering::SeqCst);
        loop {
            match next(&mut rx, within).await {
                SourceMessage::Ended(3, EndReason::Stopped) => break,
                SourceMessage::TransmitReady(..) => panic!("offered a transmit"),
                _ => {}
            }
        }
    }

    /// GVRET USB's outage handling, over the one link a test can unplug.
    fn start_waiting_out(
        port: u16,
        reopen: Duration,
    ) -> (Arc<AtomicBool>, mpsc::Receiver<SourceMessage>) {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel(64);
        let flag = stop.clone();
        tokio::spawn(async move {
            let link = Link::Tcp {
                endpoint: format!("127.0.0.1:{port}"),
                connect_timeout: Duration::from_secs(2),
            };
            let options = can_options(false, Some(reopen));
            let task = open_gvret(link, GvretOptions::default(), options)
                .await
                .expect("open");
            let mut stream = Stream::new(3, "gvret_usb", DEVICE.into(), "here".into(), vec![]);
            let mut outage = PortOutage::new(3, "here");
            let on_event =
                |event| outage.on_event(event, |_| unreachable!(), |e| stream.on_event(e));
            serve(task, 3, false, &flag, &tx, on_event, |e| {
                link_lost(3, DEVICE, e)
            })
            .await
        });
        (stop, rx)
    }

    #[tokio::test]
    async fn each_outage_is_reported_once_and_a_reconnect_resolves_the_buses_again() {
        let (port, _commands) = fake_gvret(usize::MAX, true).await;
        let (stop, mut rx) = start_waiting_out(port, Duration::from_millis(20));
        let mut seen = Vec::new();
        while seen.iter().filter(|&&m| m == "interrupted").count() < 2 {
            seen.push(match next(&mut rx, Duration::from_secs(3)).await {
                SourceMessage::MappingsResolved(3, m) => {
                    assert_eq!(m.len(), 2);
                    "resolved"
                }
                SourceMessage::Connected(3, ..) => "connected",
                SourceMessage::Interrupted(3, _) => "interrupted",
                SourceMessage::Frames(3, _) | SourceMessage::TransmitReady(3, _) => continue,
                _ => panic!("the source ended or erred"),
            });
        }
        let interrupted = ["resolved", "connected", "interrupted"];
        assert_eq!(seen, [interrupted, interrupted].concat());
        stop.store(true, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn a_transmit_while_waiting_is_refused_and_a_stop_ends_the_wait() {
        let (port, _commands) = fake_gvret(usize::MAX, true).await;
        let (stop, mut rx) = start_waiting_out(port, Duration::from_secs(60));
        let (transmit, _) = connect_and_read(&mut rx).await;
        assert!(matches!(
            next(&mut rx, Duration::from_secs(3)).await,
            SourceMessage::Interrupted(3, _)
        ));

        let frame = CanFrame::data(0, 0x321, false, false, false, vec![1]);
        assert_eq!(
            answer(send(&transmit, frame)).await,
            Err("Transmit refused: not connected".to_string())
        );
        stop.store(true, Ordering::SeqCst);
        assert!(matches!(
            next(&mut rx, Duration::from_secs(2)).await,
            SourceMessage::Ended(3, EndReason::Stopped)
        ));
    }
}

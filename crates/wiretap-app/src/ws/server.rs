// Copyright 2026 Wired Square Pty Ltd

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

use futures::sink::SinkExt;
use futures::stream::StreamExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, Duration, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;

use super::protocol::{
    Header, MsgType, HEADER_SIZE, encode_message, encode_subscribe_ack, encode_subscribe_nack,
};

/// Global server instance.
pub static WS_SERVER: OnceLock<WsServer> = OnceLock::new();

/// Convenience: get the global WsServer or return None.
pub fn ws_server() -> Option<&'static WsServer> {
    WS_SERVER.get()
}

#[derive(serde::Serialize)]
pub struct WsConfig {
    pub port: u16,
    pub token: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_ws_config() -> Result<WsConfig, String> {
    let server = ws_server().ok_or_else(|| "WebSocket server not started".to_string())?;
    Ok(WsConfig {
        port: server.port(),
        token: server.token().to_string(),
    })
}

static NEXT_CONN_ID: AtomicUsize = AtomicUsize::new(1);

/// Count of currently-authenticated connections. Lets the MCP bridge fast-fail
/// when no frontend is connected rather than waiting for a request timeout.
static AUTH_CONN_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Number of authenticated WS connections (i.e. live frontend windows).
pub fn authenticated_connection_count() -> usize {
    AUTH_CONN_COUNT.load(Ordering::Relaxed)
}

// ============================================================================
// Public API
// ============================================================================

/// Shared channel map readable from any context (sync or async) without blocking tokio.
/// Updated by the connection manager task whenever subscriptions change.
static CHANNEL_MAP: once_cell::sync::Lazy<std::sync::RwLock<HashMap<String, u8>>> =
    once_cell::sync::Lazy::new(|| std::sync::RwLock::new(HashMap::new()));

pub struct WsServer {
    port: u16,
    token: String,
    tx: mpsc::UnboundedSender<ServerCommand>,
}

/// Messages a connection may have waiting before it counts as stalled and is closed. Capture
/// replay at speed 0 sends a 1000-frame batch every 10 ms, three or four messages each, so this
/// holds over a second of it; a window that is reading never falls that far behind.
const QUEUE_CAPACITY: usize = 512;

/// Chunks of a stream held for a connection at once, so a long one is never held whole.
const STREAM_IN_FLIGHT: usize = 2;

/// How long a stream waits for its connection to take a chunk before closing it as stalled.
const STREAM_STALL: Duration = Duration::from_secs(10);

impl WsServer {
    /// Start the server. Returns (port, token). Stores global instance in `WS_SERVER`.
    pub fn start() -> Result<(u16, String), String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to bind WS listener: {e}"))?;
        let server = Self::spawn(listener, QUEUE_CAPACITY)?;
        let (port, token) = (server.port, server.token.clone());
        tlog!("[ws] Server started on 127.0.0.1:{port}");

        WS_SERVER
            .set(server)
            .map_err(|_| "WS server already started".to_string())?;

        Ok((port, token))
    }

    fn spawn(listener: std::net::TcpListener, queue_capacity: usize) -> Result<Self, String> {
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get local addr: {e}"))?
            .port();

        // Non-blocking so tokio can adopt it
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking: {e}"))?;

        let token = generate_token();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let token_for_accept = token.clone();
        let cmd_tx_for_accept = cmd_tx.clone();

        // Spawn connection manager (owns all mutable connection/channel state)
        let cmd_tx_for_manager = cmd_tx.clone();
        tauri::async_runtime::spawn(connection_manager_task(cmd_rx, cmd_tx_for_manager));

        // Spawn accept loop
        tauri::async_runtime::spawn(async move {
            let tcp_listener = TcpListener::from_std(listener)
                .expect("Failed to convert std TcpListener to tokio");
            accept_loop(tcp_listener, token_for_accept, cmd_tx_for_accept, queue_capacity).await;
        });

        Ok(WsServer { port, token, tx: cmd_tx })
    }

    /// Send a binary message to all connections subscribed to this channel.
    pub fn send_to_channel(&self, channel: u8, data: Vec<u8>) {
        let _ = self.tx.send(ServerCommand::SendToChannel { channel, data });
    }

    pub fn send_to_conn(&self, conn_id: usize, data: Vec<u8>) {
        let _ = self.tx.send(ServerCommand::SendToConn { conn_id, data });
    }

    /// What is sent through the stream reaches `conn_id` after everything already sent to it
    /// and before anything sent to it after this call.
    pub fn stream_to_conn(&self, conn_id: usize) -> ConnStream {
        let (chunks, rx) = mpsc::channel(STREAM_IN_FLIGHT);
        let _ = self.tx.send(ServerCommand::StreamToConn { conn_id, chunks: rx });
        ConnStream { conn_id, chunks, server: self.tx.clone() }
    }

    /// Send a binary message to all authenticated connections (channel 0 / global).
    pub fn send_global(&self, data: Vec<u8>) {
        let _ = self.tx.send(ServerCommand::SendGlobal { data });
    }

    /// Get the channel number for a session ID (if subscribed).
    /// Safe to call from any context (sync or async) — reads a shared RwLock, no tokio blocking.
    pub fn channel_for_session(&self, session_id: &str) -> Option<u8> {
        CHANNEL_MAP.read().ok().and_then(|m| m.get(session_id).copied())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

pub struct ConnStream {
    conn_id: usize,
    chunks: mpsc::Sender<Vec<u8>>,
    server: mpsc::UnboundedSender<ServerCommand>,
}

impl ConnStream {
    /// Waits while the connection is behind; false once it is gone, or once it has taken
    /// nothing for `STREAM_STALL`, when it is closed as stalled. Not for an async worker.
    pub fn send(&self, data: Vec<u8>) -> bool {
        let sent = tauri::async_runtime::block_on(async { tokio::time::timeout(STREAM_STALL, self.chunks.send(data)).await });
        match sent {
            Ok(sent) => sent.is_ok(),
            Err(_) => {
                let _ = self.server.send(ServerCommand::Close { conn_id: self.conn_id, reason: "stream stalled" });
                false
            }
        }
    }
}

// ============================================================================
// Server commands
// ============================================================================

enum ServerCommand {
    /// A new connection's writer is running.
    NewConnection {
        conn_id: usize,
        queue: mpsc::Sender<Outbound>,
        closer: CancellationToken,
    },
    /// Send message to all connections subscribed to this channel.
    SendToChannel { channel: u8, data: Vec<u8> },
    /// Send message to all authenticated connections (channel 0).
    SendGlobal { data: Vec<u8> },
    /// A connection authenticated successfully.
    Authenticated { conn_id: usize },
    /// Subscribe a connection to a session.
    Subscribe {
        conn_id: usize,
        session_id: String,
        reply: oneshot::Sender<Result<u8, String>>,
    },
    /// Remove a subscription.
    Unsubscribe { conn_id: usize, channel: u8 },
    /// Send message to a specific connection.
    SendToConn { conn_id: usize, data: Vec<u8> },
    StreamToConn { conn_id: usize, chunks: mpsc::Receiver<Vec<u8>> },
    /// Connection closed.
    ConnectionClosed { conn_id: usize },
    Close { conn_id: usize, reason: &'static str },
    /// Record activity on a connection (for heartbeat timeout).
    Activity { conn_id: usize },
    /// Touch IO listener heartbeats for all sessions a connection is subscribed to.
    /// Sent when a client Heartbeat message is received, bridging WS keepalive
    /// to the IO session watchdog so the frontend needs no subscriber polling of its own.
    HeartbeatListeners { conn_id: usize },
    /// Execute a command received from a client and send the response back.
    ExecuteCommand {
        conn_id: usize,
        correlation_id: u32,
        op_name: String,
        params: Vec<u8>,
    },
}

type SplitSink = futures::stream::SplitSink<WebSocketStream<TcpStream>, Message>;

// ============================================================================
// Channel map
// ============================================================================

struct ChannelMap {
    session_to_channel: HashMap<String, u8>,
    channel_to_session: HashMap<u8, String>,
    next_channel: u8,
}

impl ChannelMap {
    fn new() -> Self {
        Self {
            session_to_channel: HashMap::new(),
            channel_to_session: HashMap::new(),
            next_channel: 1,
        }
    }

    /// Allocate a channel for a session. Returns existing channel if already mapped.
    fn allocate(&mut self, session_id: &str) -> Result<u8, String> {
        if let Some(&ch) = self.session_to_channel.get(session_id) {
            return Ok(ch);
        }

        // Find next free channel in 1..=254
        let start = self.next_channel;
        loop {
            if !self.channel_to_session.contains_key(&self.next_channel) {
                let ch = self.next_channel;
                self.session_to_channel.insert(session_id.to_string(), ch);
                self.channel_to_session.insert(ch, session_id.to_string());
                self.next_channel = if ch == 254 { 1 } else { ch + 1 };
                return Ok(ch);
            }
            self.next_channel = if self.next_channel == 254 {
                1
            } else {
                self.next_channel + 1
            };
            if self.next_channel == start {
                return Err("No channels available (254 sessions active)".to_string());
            }
        }
    }

    fn release(&mut self, channel: u8) {
        if let Some(session_id) = self.channel_to_session.remove(&channel) {
            self.session_to_channel.remove(&session_id);
        }
    }

}

// ============================================================================
// Connection state
// ============================================================================

/// What a connection's writer sends: a message, or a stream whose chunks all go before the next.
enum Outbound {
    Message(Message),
    Stream(mpsc::Receiver<Vec<u8>>),
}

struct Connection {
    queue: mpsc::Sender<Outbound>,
    closer: CancellationToken,
    authenticated: bool,
    subscribed_channels: HashSet<u8>,
    last_activity: Instant,
}

impl Connection {
    /// False when the queue is full: the connection has stalled. A gone writer is not a stall —
    /// its read task reports the close.
    fn enqueue(&self, item: Outbound) -> bool {
        !matches!(self.queue.try_send(item), Err(mpsc::error::TrySendError::Full(_)))
    }

    fn queued(&self) -> usize {
        self.queue.max_capacity() - self.queue.capacity()
    }
}

struct Connections {
    by_id: HashMap<usize, Connection>,
    channel_map: ChannelMap,
    /// How many connections subscribe to each channel.
    channel_refcount: HashMap<u8, usize>,
}

impl Connections {
    /// Send to every connection `to` picks, closing any that has stalled.
    fn send(&mut self, msg: Message, to: impl Fn(usize, &Connection) -> bool) {
        let stalled: Vec<usize> = self
            .by_id
            .iter()
            .filter(|&(id, conn)| to(*id, conn) && !conn.enqueue(Outbound::Message(msg.clone())))
            .map(|(id, _)| *id)
            .collect();
        for conn_id in stalled {
            self.close(conn_id, "outbound queue full");
        }
    }

    fn remove(&mut self, conn_id: usize) -> Option<Connection> {
        crate::adhoc::forget_connection(conn_id);
        let conn = self.by_id.remove(&conn_id)?;
        if conn.authenticated {
            AUTH_CONN_COUNT.fetch_sub(1, Ordering::Relaxed);
        }
        for ch in &conn.subscribed_channels {
            decrement_refcount(&mut self.channel_refcount, &mut self.channel_map, *ch);
        }
        Some(conn)
    }

    /// Drop the socket; the client reconnects and subscribes again.
    fn close(&mut self, conn_id: usize, reason: &str) {
        if let Some(conn) = self.remove(conn_id) {
            conn.closer.cancel();
            tlog!("[ws] Connection {conn_id} closed: {reason} ({} queued)", conn.queued());
        }
    }
}

// ============================================================================
// Connection manager task
// ============================================================================

async fn connection_manager_task(
    mut cmd_rx: mpsc::UnboundedReceiver<ServerCommand>,
    cmd_tx: mpsc::UnboundedSender<ServerCommand>,
) {
    let mut conns = Connections {
        by_id: HashMap::new(),
        channel_map: ChannelMap::new(),
        channel_refcount: HashMap::new(),
    };

    let mut heartbeat_interval = interval(Duration::from_secs(30));
    heartbeat_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    ServerCommand::NewConnection { conn_id, queue, closer } => {
                        conns.by_id.insert(conn_id, Connection {
                            queue,
                            closer,
                            authenticated: false,
                            subscribed_channels: HashSet::new(),
                            last_activity: Instant::now(),
                        });
                        tlog!("[ws] Connection {conn_id} registered");
                    }

                    ServerCommand::Authenticated { conn_id } => {
                        if let Some(conn) = conns.by_id.get_mut(&conn_id) {
                            if !conn.authenticated {
                                AUTH_CONN_COUNT.fetch_add(1, Ordering::Relaxed);
                            }
                            conn.authenticated = true;
                            conn.last_activity = Instant::now();
                        }
                    }

                    ServerCommand::SendToConn { conn_id, data } => {
                        conns.send(Message::Binary(data.into()), |id, _| id == conn_id);
                    }

                    ServerCommand::StreamToConn { conn_id, chunks } => {
                        if conns.by_id.get(&conn_id).is_some_and(|conn| !conn.enqueue(Outbound::Stream(chunks))) {
                            conns.close(conn_id, "outbound queue full");
                        }
                    }

                    ServerCommand::SendToChannel { channel, data } => {
                        conns.send(Message::Binary(data.into()), |_, conn| {
                            conn.authenticated && conn.subscribed_channels.contains(&channel)
                        });
                    }

                    ServerCommand::SendGlobal { data } => {
                        conns.send(Message::Binary(data.into()), |_, conn| conn.authenticated);
                    }

                    ServerCommand::Subscribe { conn_id, session_id, reply } => {
                        let result = conns.channel_map.allocate(&session_id);
                        match &result {
                            Ok(ch) => {
                                if let Some(conn) = conns.by_id.get_mut(&conn_id) {
                                    conn.subscribed_channels.insert(*ch);
                                    conn.last_activity = Instant::now();
                                    *conns.channel_refcount.entry(*ch).or_insert(0) += 1;

                                    let ack = encode_message(
                                        MsgType::SubscribeAck,
                                        0,
                                        &encode_subscribe_ack(*ch, &session_id),
                                    );
                                    conns.send(Message::Binary(ack.into()), |id, _| id == conn_id);
                                }
                                // Update shared channel map for non-blocking lookups
                                if let Ok(mut map) = CHANNEL_MAP.write() {
                                    map.insert(session_id.clone(), *ch);
                                }
                                crate::ws::dispatch::reset_frame_offset(&session_id);
                                // A byte capture that already holds bytes pushes no
                                // count of its own — `send_new_bytes` runs off arriving
                                // data. Without this a session opened on an existing
                                // byte capture reports zero bytes forever and the serial
                                // view waits for data that is already there.
                                crate::ws::dispatch::send_new_bytes(&session_id);
                                tlog!("[ws] Connection {conn_id} subscribed to session '{session_id}' on channel {ch}");
                            }
                            Err(e) => {
                                let nack = encode_message(
                                    MsgType::SubscribeNack,
                                    0,
                                    &encode_subscribe_nack(&session_id, e),
                                );
                                conns.send(Message::Binary(nack.into()), |id, _| id == conn_id);
                                tlog!("[ws] Connection {conn_id} subscribe failed for '{session_id}': {e}");
                            }
                        }
                        let _ = reply.send(result);
                    }

                    ServerCommand::Unsubscribe { conn_id, channel } => {
                        if let Some(conn) = conns.by_id.get_mut(&conn_id) {
                            conn.subscribed_channels.remove(&channel);
                            conn.last_activity = Instant::now();
                            // Only a deliberate leave drops the decoder: a dropped connection
                            // reconnects to a session that still has one.
                            if let Some(sid) = decrement_refcount(&mut conns.channel_refcount, &mut conns.channel_map, channel) {
                                crate::ws::dispatch::detach_catalog(&sid);
                            }
                            tlog!("[ws] Connection {conn_id} unsubscribed from channel {channel}");
                        }
                    }

                    ServerCommand::ConnectionClosed { conn_id } => {
                        if conns.remove(conn_id).is_some() {
                            tlog!("[ws] Connection {conn_id} closed");
                        }
                    }

                    ServerCommand::Close { conn_id, reason } => conns.close(conn_id, reason),

                    ServerCommand::Activity { conn_id } => {
                        if let Some(conn) = conns.by_id.get_mut(&conn_id) {
                            conn.last_activity = Instant::now();
                        }
                    }

                    ServerCommand::HeartbeatListeners { conn_id } => {
                        if let Some(conn) = conns.by_id.get(&conn_id) {
                            let session_ids: Vec<String> = conn.subscribed_channels.iter()
                                .filter_map(|ch| conns.channel_map.channel_to_session.get(ch).cloned())
                                .collect();
                            if !session_ids.is_empty() {
                                tauri::async_runtime::spawn(touch_subscriber_heartbeats(session_ids));
                            }
                        }
                    }

                    ServerCommand::ExecuteCommand { conn_id, correlation_id, op_name, params } => {
                        let cmd_tx_clone = cmd_tx.clone(); // send response back through the command channel
                        tauri::async_runtime::spawn(async move {
                            let result = crate::ws::dispatch::dispatch_command(&op_name, &params, conn_id).await;
                            let (status, payload) = match result {
                                Ok(value) => {
                                    let json = serde_json::to_vec(&value).unwrap_or_default();
                                    (0u8, json)
                                }
                                Err(err) => (1u8, err.into_bytes()),
                            };
                            let response_payload = super::protocol::encode_command_response(
                                correlation_id, status, &payload,
                            );
                            let msg = super::protocol::encode_message(
                                super::protocol::MsgType::CommandResponse, 0, &response_payload,
                            );
                            let _ = cmd_tx_clone.send(ServerCommand::SendToConn {
                                conn_id,
                                data: msg,
                            });
                        });
                    }

                }
            }

            _ = heartbeat_interval.tick() => {
                let now = Instant::now();

                // Collect IDs of timed-out connections
                // 2x the IO subscriber timeout: the socket must outlive IO
                // suspension so a display-sleep wake resumes on the same
                // connection without a reconnect/resubscribe round trip.
                let conn_timeout = Duration::from_secs(2 * crate::io::HEARTBEAT_TIMEOUT_SECS);
                let timed_out: Vec<usize> = conns.by_id.iter()
                    .filter(|(_, conn)| conn.authenticated && now.duration_since(conn.last_activity) > conn_timeout)
                    .map(|(id, _)| *id)
                    .collect();

                for conn_id in timed_out {
                    conns.close(conn_id, &format!("timed out (no activity for {}s)", conn_timeout.as_secs()));
                }

                let heartbeat = encode_message(MsgType::Heartbeat, 0, &[]);
                conns.send(Message::Binary(heartbeat.into()), |_, conn| conn.authenticated);
            }

            else => break,
        }
    }

    tlog!("[ws] Connection manager task exiting");
}

/// The session whose channel this released, once no connection subscribes to it.
fn decrement_refcount(
    refcount: &mut HashMap<u8, usize>,
    channel_map: &mut ChannelMap,
    channel: u8,
) -> Option<String> {
    let count = refcount.get_mut(&channel)?;
    *count = count.saturating_sub(1);
    if *count > 0 {
        return None;
    }
    refcount.remove(&channel);
    // Grab the session_id before releasing so we can clear its frame offset.
    let sid = channel_map.channel_to_session.get(&channel).cloned();
    channel_map.release(channel);
    let sid = sid?;
    // Remove from shared channel map
    if let Ok(mut map) = CHANNEL_MAP.write() {
        map.remove(&sid);
    }
    crate::ws::dispatch::clear_frame_offset(&sid);
    Some(sid)
}

/// Writes a connection's queue to its socket, so a slow one holds up no other. Ends when the
/// manager drops the queue, the socket fails or `closer` fires, and then fires `closer` itself.
async fn connection_write_task(
    conn_id: usize,
    mut sink: SplitSink,
    mut outbound: mpsc::Receiver<Outbound>,
    closer: CancellationToken,
) {
    let written = closer
        .run_until_cancelled(async {
            while let Some(item) = outbound.recv().await {
                match item {
                    Outbound::Message(msg) => sink.send(msg).await?,
                    Outbound::Stream(mut chunks) => {
                        while let Some(chunk) = chunks.recv().await {
                            sink.send(Message::Binary(chunk.into())).await?;
                        }
                    }
                }
            }
            Ok::<_, tokio_tungstenite::tungstenite::Error>(())
        })
        .await;
    if let Some(Err(e)) = written {
        tlog!("[ws] Connection {conn_id}: send failed: {e}");
    }
    closer.cancel();
}

// ============================================================================
// Accept loop
// ============================================================================

async fn accept_loop(
    listener: TcpListener,
    token: String,
    cmd_tx: mpsc::UnboundedSender<ServerCommand>,
    queue_capacity: usize,
) {
    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
                tlog!("[ws] Accepted connection {conn_id} from {addr}");

                let token = token.clone();
                let cmd_tx = cmd_tx.clone();

                tauri::async_runtime::spawn(async move {
                    match tokio_tungstenite::accept_async(stream).await {
                        Ok(ws_stream) => {
                            let (write, read) = ws_stream.split();
                            let (queue, outbound) = mpsc::channel(queue_capacity);
                            let closer = CancellationToken::new();
                            tauri::async_runtime::spawn(connection_write_task(conn_id, write, outbound, closer.clone()));
                            let _ = cmd_tx.send(ServerCommand::NewConnection { conn_id, queue, closer: closer.clone() });

                            closer.run_until_cancelled(connection_read_task(conn_id, read, token, cmd_tx.clone())).await;
                            let _ = cmd_tx.send(ServerCommand::ConnectionClosed { conn_id });
                        }
                        Err(e) => {
                            tlog!("[ws] WebSocket handshake failed for connection {conn_id}: {e}");
                        }
                    }
                });
            }
            Err(e) => {
                tlog!("[ws] Accept error: {e}");
            }
        }
    }
}

// ============================================================================
// Per-connection read task
// ============================================================================

type SplitStream = futures::stream::SplitStream<WebSocketStream<TcpStream>>;

async fn connection_read_task(
    conn_id: usize,
    mut read: SplitStream,
    token: String,
    cmd_tx: mpsc::UnboundedSender<ServerCommand>,
) {
    let mut authenticated = false;

    while let Some(result) = read.next().await {
        match result {
            Ok(Message::Binary(data)) => {
                let _ = cmd_tx.send(ServerCommand::Activity { conn_id });

                if data.len() < HEADER_SIZE {
                    tlog!("[ws] Connection {conn_id}: message too short ({} bytes)", data.len());
                    continue;
                }

                let header = match Header::decode(&data) {
                    Ok(h) => h,
                    Err(e) => {
                        tlog!("[ws] Connection {conn_id}: invalid header: {e:?}");
                        continue;
                    }
                };

                let payload = &data[HEADER_SIZE..];

                match header.msg_type {
                    MsgType::Auth => {
                        let received_token = std::str::from_utf8(payload).unwrap_or("");
                        if received_token == token {
                            authenticated = true;
                            let _ = cmd_tx.send(ServerCommand::Authenticated { conn_id });
                            // Send Auth ack via connection manager (it owns the sender)
                            let ack = encode_message(MsgType::Auth, 0, &[]);
                            let _ = cmd_tx.send(ServerCommand::SendToConn { conn_id, data: ack });
                            tlog!("[ws] Connection {conn_id}: authenticated");
                        } else {
                            tlog!("[ws] Connection {conn_id}: auth failed (bad token)");
                        }
                    }

                    MsgType::Subscribe => {
                        if !authenticated {
                            tlog!("[ws] Connection {conn_id}: subscribe before auth, ignoring");
                            continue;
                        }
                        let session_id = match std::str::from_utf8(payload) {
                            Ok(s) => s.to_string(),
                            Err(_) => {
                                tlog!("[ws] Connection {conn_id}: invalid UTF-8 in subscribe payload");
                                continue;
                            }
                        };
                        let (reply_tx, _reply_rx) = oneshot::channel();
                        let _ = cmd_tx.send(ServerCommand::Subscribe {
                            conn_id,
                            session_id,
                            reply: reply_tx,
                        });
                        // The connection manager sends SubscribeAck/Nack directly
                    }

                    MsgType::Unsubscribe => {
                        if !authenticated {
                            continue;
                        }
                        let channel = header.channel;
                        let _ = cmd_tx.send(ServerCommand::Unsubscribe { conn_id, channel });
                    }

                    MsgType::Heartbeat => {
                        // Activity already recorded above.
                        // Also touch IO listener heartbeats for all sessions this
                        // connection is subscribed to, bridging WS keepalive to
                        // the IO session watchdog.
                        let _ = cmd_tx.send(ServerCommand::HeartbeatListeners { conn_id });
                    }

                    MsgType::Command => {
                        if !authenticated {
                            tlog!("[ws] Connection {conn_id}: command before auth, ignoring");
                            continue;
                        }
                        match super::protocol::decode_command(payload) {
                            Ok(cmd) => {
                                let _ = cmd_tx.send(ServerCommand::ExecuteCommand {
                                    conn_id,
                                    correlation_id: cmd.correlation_id,
                                    op_name: cmd.op_name,
                                    params: cmd.params,
                                });
                            }
                            Err(e) => {
                                tlog!("[ws] Connection {conn_id}: invalid command payload: {e:?}");
                            }
                        }
                    }

                    MsgType::BridgeResponse => {
                        if !authenticated {
                            continue;
                        }
                        match super::protocol::decode_bridge_response(payload) {
                            Ok(resp) => {
                                crate::mcp::bridge::resolve(resp.correlation_id, resp.status, resp.payload);
                            }
                            Err(e) => {
                                tlog!("[ws] Connection {conn_id}: invalid bridge response: {e:?}");
                            }
                        }
                    }

                    _ => {
                        // Frontend shouldn't send data messages; ignore silently
                    }
                }
            }

            Ok(Message::Close(_)) => {
                tlog!("[ws] Connection {conn_id}: received close frame");
                break;
            }

            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                let _ = cmd_tx.send(ServerCommand::Activity { conn_id });
            }

            Ok(_) => {
                // Text frames, etc. — ignore
            }

            Err(e) => {
                tlog!("[ws] Connection {conn_id}: read error: {e}");
                break;
            }
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Update `last_heartbeat` on all listeners for the given sessions.
/// This bridges the WS keepalive to the IO session watchdog, allowing
/// the frontend to stop sending per-listener invoke calls.
async fn touch_subscriber_heartbeats(session_ids: Vec<String>) {
    crate::io::touch_subscriber_heartbeats(&session_ids).await;
}

fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Mix multiple entropy sources into a simple token.
    // Not cryptographic, but sufficient for local-only auth.
    let time_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let ptr_entropy = &time_ns as *const _ as usize;
    let pid = std::process::id();

    let mut state: u64 = time_ns as u64 ^ (ptr_entropy as u64) ^ (pid as u64);
    let mut token = String::with_capacity(32);
    for _ in 0..32 {
        // xorshift64
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let nibble = (state & 0x0F) as u8;
        token.push(char::from(if nibble < 10 { b'0' + nibble } else { b'a' + nibble - 10 }));
    }
    token
}

/// A server with no sockets behind it: tests read what would have been sent, and to whom.
#[cfg(test)]
pub(crate) mod outbox {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug, PartialEq)]
    pub(crate) enum Recipient {
        Conn(usize),
        Channel(u8),
    }

    type Sent = (Recipient, Vec<u8>);

    struct Outbox {
        commands: mpsc::UnboundedReceiver<ServerCommand>,
        /// Streams still open: another test may be mid-way through one.
        streams: Vec<(usize, mpsc::Receiver<Vec<u8>>)>,
        unread: Vec<Sent>,
    }

    /// The queue and what was read off it for another test: tests run in parallel, so one
    /// test's read must not drop the messages another is about to ask for.
    static SENT: OnceLock<Mutex<Outbox>> = OnceLock::new();

    pub(crate) fn subscribe(session_id: &str, channel: u8) {
        SENT.get_or_init(|| {
            let (tx, commands) = mpsc::unbounded_channel();
            assert!(
                WS_SERVER.set(WsServer { port: 0, token: String::new(), tx }).is_ok(),
                "no real server runs under test"
            );
            Mutex::new(Outbox { commands, streams: Vec::new(), unread: Vec::new() })
        });
        CHANNEL_MAP.write().unwrap().insert(session_id.to_string(), channel);
    }

    /// Every message sent so far on `channel` of type `kind`: its recipient and payload.
    pub(crate) fn sent(channel: u8, kind: MsgType) -> Vec<Sent> {
        let mut guard = SENT.get().expect("subscribe first").lock().unwrap();
        let Outbox { commands, streams, unread } = &mut *guard;
        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                ServerCommand::SendToConn { conn_id, data } => unread.push((Recipient::Conn(conn_id), data)),
                ServerCommand::SendToChannel { channel, data } => unread.push((Recipient::Channel(channel), data)),
                ServerCommand::StreamToConn { conn_id, chunks } => streams.push((conn_id, chunks)),
                _ => {}
            }
        }
        streams.retain_mut(|(conn_id, chunks)| loop {
            match chunks.try_recv() {
                Ok(data) => unread.push((Recipient::Conn(*conn_id), data)),
                Err(mpsc::error::TryRecvError::Empty) => break true,
                Err(mpsc::error::TryRecvError::Disconnected) => break false,
            }
        });
        let (wanted, rest): (Vec<Sent>, Vec<Sent>) = std::mem::take(unread)
            .into_iter()
            .partition(|(_, data)| Header::decode(data).is_ok_and(|h| h.channel == channel && h.msg_type == kind));
        *unread = rest;
        wanted.into_iter().map(|(recipient, data)| (recipient, data[HEADER_SIZE..].to_vec())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_keeps_its_channel_and_channels_count_up_from_one() {
        let mut map = ChannelMap::new();
        assert_eq!(map.allocate("a"), Ok(1));
        assert_eq!(map.allocate("b"), Ok(2));
        assert_eq!(map.allocate("a"), Ok(1));
    }

    #[test]
    fn a_released_channel_is_reused_only_after_the_counter_wraps() {
        let mut map = ChannelMap::new();
        map.allocate("a").unwrap();
        map.allocate("b").unwrap();
        map.release(1);
        assert_eq!(map.allocate("c"), Ok(3));
        for n in 4..=254 {
            assert_eq!(map.allocate(&format!("s{n}")), Ok(n));
        }
        assert_eq!(map.allocate("wrapped"), Ok(1));
    }

    #[test]
    fn the_255th_session_is_refused() {
        let mut map = ChannelMap::new();
        for n in 1..=254u8 {
            assert_eq!(map.allocate(&format!("s{n}")), Ok(n));
        }
        assert_eq!(map.allocate("one-too-many"), Err("No channels available (254 sessions active)".to_string()));
        map.release(100);
        assert_eq!(map.allocate("one-too-many"), Ok(100));
    }

    #[test]
    fn a_connection_holds_its_capacity_then_counts_as_stalled() {
        let (queue, _outbound) = mpsc::channel(3);
        let conn = Connection {
            queue,
            closer: CancellationToken::new(),
            authenticated: true,
            subscribed_channels: HashSet::new(),
            last_activity: Instant::now(),
        };
        let msg = || Outbound::Message(Message::Binary(vec![0].into()));
        assert!((0..3).all(|_| conn.enqueue(msg())));
        assert!(!conn.enqueue(msg()));
        assert_eq!(conn.queued(), 3);
    }

    #[test]
    fn a_sessions_catalogue_outlives_the_connection_that_last_subscribed_to_it() {
        let session = "ws-catalogue-outlives-connection";
        let conn_id = usize::MAX;
        let mut conns = Connections { by_id: HashMap::new(), channel_map: ChannelMap::new(), channel_refcount: HashMap::new() };
        let channel = conns.channel_map.allocate(session).unwrap();
        conns.channel_refcount.insert(channel, 1);
        let (queue, _outbound) = mpsc::channel(1);
        conns.by_id.insert(conn_id, Connection {
            queue,
            closer: CancellationToken::new(),
            authenticated: false,
            subscribed_channels: HashSet::from([channel]),
            last_activity: Instant::now(),
        });
        let catalog = wiretap_catalog::Catalog::parse("[meta]\nname = \"kept\"\n").unwrap();
        crate::ws::dispatch::attach_catalog(session, Some("kept.toml".into()), catalog);

        conns.close(conn_id, "outbound queue full");

        let kept = crate::ws::dispatch::attached_catalog_path(session);
        crate::ws::dispatch::detach_catalog(session);
        assert_eq!(kept.as_deref(), Some("kept.toml"));
    }

    fn within<T>(limit: Duration, work: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(async { tokio::time::timeout(limit, work).await.expect("finished in time") })
    }

    type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

    /// The next message of `kind`, skipping heartbeats and the like; `None` once the server has closed.
    async fn next_of(client: &mut Client, kind: MsgType) -> Option<Vec<u8>> {
        loop {
            match client.next().await? {
                Ok(Message::Binary(data)) if Header::decode(&data).is_ok_and(|h| h.msg_type == kind) => {
                    return Some(data[HEADER_SIZE..].to_vec());
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    /// An authenticated window subscribed to `session`, and the session's channel.
    async fn join(server: &WsServer, session: &str) -> (Client, u8) {
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", server.port))
            .await
            .expect("connects");
        client.send(Message::Binary(encode_message(MsgType::Auth, 0, server.token.as_bytes()).into())).await.unwrap();
        next_of(&mut client, MsgType::Auth).await.expect("authenticated");
        client.send(Message::Binary(encode_message(MsgType::Subscribe, 0, session.as_bytes()).into())).await.unwrap();
        let ack = next_of(&mut client, MsgType::SubscribeAck).await.expect("subscribed");
        (client, ack[0])
    }

    #[test]
    fn a_window_that_stops_reading_is_closed_and_the_others_keep_receiving() {
        const SENT: u32 = 400;
        let server = WsServer::spawn(std::net::TcpListener::bind("127.0.0.1:0").unwrap(), 8).unwrap();
        within(Duration::from_secs(20), async {
            let session = "ws-one-window-stops-reading";
            let (mut reading, channel) = join(&server, session).await;
            let (mut stalled, _) = join(&server, session).await;

            for n in 0..SENT {
                let mut batch = n.to_be_bytes().to_vec();
                batch.resize(128 * 1024, 0);
                server.send_to_channel(channel, encode_message(MsgType::FrameData, channel, &batch));
                let got = next_of(&mut reading, MsgType::FrameData).await.expect("the reading window stays open");
                assert_eq!(got[..4], n.to_be_bytes());
            }

            let mut seen = 0;
            while next_of(&mut stalled, MsgType::FrameData).await.is_some() {
                seen += 1;
            }
            assert!(seen < SENT, "closed after {seen} of {SENT}");
        });
    }

    #[test]
    fn a_stream_goes_out_whole_before_what_was_queued_after_it() {
        within(Duration::from_secs(10), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let accepted = async { tokio_tungstenite::accept_async(listener.accept().await.unwrap().0).await.unwrap() };
            let (connected, accepted) = tokio::join!(tokio_tungstenite::connect_async(url), accepted);
            let (mut client, _) = connected.unwrap();
            let (sink, _read) = accepted.split();
            let (queue, outbound) = mpsc::channel(4);
            let closer = CancellationToken::new();
            let writer = tokio::spawn(connection_write_task(1, sink, outbound, closer.clone()));

            let byte = |b: u8| Outbound::Message(Message::Binary(vec![b].into()));
            let (chunks, stream) = mpsc::channel(STREAM_IN_FLIGHT);
            for item in [byte(0), Outbound::Stream(stream), byte(9)] {
                assert!(queue.try_send(item).is_ok());
            }
            tokio::spawn(async move {
                for n in 1..=5u8 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    chunks.send(vec![n]).await.unwrap();
                }
            });

            let mut got = Vec::new();
            while got.len() < 7 {
                match client.next().await {
                    Some(Ok(Message::Binary(data))) => got.push(data[0]),
                    other => panic!("{other:?}"),
                }
            }
            assert_eq!(got, [0, 1, 2, 3, 4, 5, 9]);

            drop(queue);
            writer.await.unwrap();
            assert!(closer.is_cancelled(), "a finished writer ends the read side too");
        });
    }

    #[test]
    fn a_token_is_32_lowercase_hex_digits() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}

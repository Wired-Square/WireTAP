// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

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

use super::protocol::{
    Header, MsgType, HEADER_SIZE, encode_message, encode_subscribe_ack, encode_subscribe_nack,
};

/// Global server instance.
pub static WS_SERVER: OnceLock<WsServer> = OnceLock::new();

/// Convenience: get the global WsServer or return None.
pub fn ws_server() -> Option<&'static WsServer> {
    WS_SERVER.get()
}

static NEXT_CONN_ID: AtomicUsize = AtomicUsize::new(1);

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

impl WsServer {
    /// Start the server. Returns (port, token). Stores global instance in `WS_SERVER`.
    pub fn start() -> Result<(u16, String), String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to bind WS listener: {e}"))?;
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
            accept_loop(tcp_listener, token_for_accept, cmd_tx_for_accept).await;
        });

        tlog!("[ws] Server started on 127.0.0.1:{port}");

        let server = WsServer {
            port,
            token: token.clone(),
            tx: cmd_tx,
        };

        WS_SERVER
            .set(server)
            .map_err(|_| "WS server already started".to_string())?;

        Ok((port, token))
    }

    /// Send a binary message to all connections subscribed to this channel.
    pub fn send_to_channel(&self, channel: u8, data: Vec<u8>) {
        let _ = self.tx.send(ServerCommand::SendToChannel { channel, data });
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

// ============================================================================
// Server commands
// ============================================================================

enum ServerCommand {
    /// A new connection's write-half is ready.
    NewConnection {
        conn_id: usize,
        sender: SplitSink,
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
    /// Connection closed.
    ConnectionClosed { conn_id: usize },
    /// Record activity on a connection (for heartbeat timeout).
    Activity { conn_id: usize },
    /// Touch IO listener heartbeats for all sessions a connection is subscribed to.
    /// Sent when a client Heartbeat message is received, bridging WS keepalive
    /// to the IO session watchdog so the frontend can skip `register_session_listener` polling.
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

struct Connection {
    sender: SplitSink,
    authenticated: bool,
    subscribed_channels: HashSet<u8>,
    last_activity: Instant,
    send_warned: bool,
}

// ============================================================================
// Connection manager task
// ============================================================================

async fn connection_manager_task(
    mut cmd_rx: mpsc::UnboundedReceiver<ServerCommand>,
    cmd_tx: mpsc::UnboundedSender<ServerCommand>,
) {
    let mut connections: HashMap<usize, Connection> = HashMap::new();
    let mut channel_map = ChannelMap::new();
    // Track how many connections subscribe to each channel
    let mut channel_refcount: HashMap<u8, usize> = HashMap::new();

    let mut heartbeat_interval = interval(Duration::from_secs(30));
    heartbeat_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    ServerCommand::NewConnection { conn_id, sender } => {
                        connections.insert(conn_id, Connection {
                            sender,
                            authenticated: false,
                            subscribed_channels: HashSet::new(),
                            last_activity: Instant::now(),
                            send_warned: false,
                        });
                        tlog!("[ws] Connection {conn_id} registered");
                    }

                    ServerCommand::Authenticated { conn_id } => {
                        if let Some(conn) = connections.get_mut(&conn_id) {
                            conn.authenticated = true;
                            conn.last_activity = Instant::now();
                        }
                    }

                    ServerCommand::SendToConn { conn_id, data } => {
                        if let Some(conn) = connections.get_mut(&conn_id) {
                            send_or_warn(conn, Message::Binary(data.into())).await;
                        }
                    }

                    ServerCommand::SendToChannel { channel, data } => {
                        let msg = Message::Binary(data.into());
                        for conn in connections.values_mut() {
                            if conn.authenticated && conn.subscribed_channels.contains(&channel) {
                                send_or_warn(conn, msg.clone()).await;
                            }
                        }
                    }

                    ServerCommand::SendGlobal { data } => {
                        let msg = Message::Binary(data.into());
                        for conn in connections.values_mut() {
                            if conn.authenticated {
                                send_or_warn(conn, msg.clone()).await;
                            }
                        }
                    }

                    ServerCommand::Subscribe { conn_id, session_id, reply } => {
                        let result = channel_map.allocate(&session_id);
                        match &result {
                            Ok(ch) => {
                                if let Some(conn) = connections.get_mut(&conn_id) {
                                    conn.subscribed_channels.insert(*ch);
                                    conn.last_activity = Instant::now();
                                    *channel_refcount.entry(*ch).or_insert(0) += 1;

                                    let ack = encode_message(
                                        MsgType::SubscribeAck,
                                        0,
                                        &encode_subscribe_ack(*ch, &session_id),
                                    );
                                    send_or_warn(conn, Message::Binary(ack.into())).await;
                                }
                                // Update shared channel map for non-blocking lookups
                                if let Ok(mut map) = CHANNEL_MAP.write() {
                                    map.insert(session_id.clone(), *ch);
                                }
                                crate::ws::dispatch::reset_frame_offset(&session_id);
                                tlog!("[ws] Connection {conn_id} subscribed to session '{session_id}' on channel {ch}");
                            }
                            Err(e) => {
                                if let Some(conn) = connections.get_mut(&conn_id) {
                                    let nack = encode_message(
                                        MsgType::SubscribeNack,
                                        0,
                                        &encode_subscribe_nack(e),
                                    );
                                    send_or_warn(conn, Message::Binary(nack.into())).await;
                                }
                                tlog!("[ws] Connection {conn_id} subscribe failed for '{session_id}': {e}");
                            }
                        }
                        let _ = reply.send(result);
                    }

                    ServerCommand::Unsubscribe { conn_id, channel } => {
                        if let Some(conn) = connections.get_mut(&conn_id) {
                            conn.subscribed_channels.remove(&channel);
                            conn.last_activity = Instant::now();
                            decrement_refcount(&mut channel_refcount, &mut channel_map, channel);
                            tlog!("[ws] Connection {conn_id} unsubscribed from channel {channel}");
                        }
                    }

                    ServerCommand::ConnectionClosed { conn_id } => {
                        if let Some(conn) = connections.remove(&conn_id) {
                            for ch in &conn.subscribed_channels {
                                decrement_refcount(&mut channel_refcount, &mut channel_map, *ch);
                            }
                            tlog!("[ws] Connection {conn_id} closed");
                        }
                    }

                    ServerCommand::Activity { conn_id } => {
                        if let Some(conn) = connections.get_mut(&conn_id) {
                            conn.last_activity = Instant::now();
                        }
                    }

                    ServerCommand::HeartbeatListeners { conn_id } => {
                        if let Some(conn) = connections.get(&conn_id) {
                            let session_ids: Vec<String> = conn.subscribed_channels.iter()
                                .filter_map(|ch| channel_map.channel_to_session.get(ch).cloned())
                                .collect();
                            if !session_ids.is_empty() {
                                tauri::async_runtime::spawn(touch_listener_heartbeats(session_ids));
                            }
                        }
                    }

                    ServerCommand::ExecuteCommand { conn_id, correlation_id, op_name, params } => {
                        let cmd_tx_clone = cmd_tx.clone(); // send response back through the command channel
                        tauri::async_runtime::spawn(async move {
                            let result = crate::ws::dispatch::dispatch_command(&op_name, &params).await;
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
                let heartbeat = encode_message(MsgType::Heartbeat, 0, &[]);
                let msg = Message::Binary(heartbeat.into());

                // Collect IDs of timed-out connections
                let timed_out: Vec<usize> = connections.iter()
                    .filter(|(_, conn)| conn.authenticated && now.duration_since(conn.last_activity) > Duration::from_secs(60))
                    .map(|(id, _)| *id)
                    .collect();

                for conn_id in timed_out {
                    if let Some(mut conn) = connections.remove(&conn_id) {
                        for ch in &conn.subscribed_channels {
                            decrement_refcount(&mut channel_refcount, &mut channel_map, *ch);
                        }
                        let _ = conn.sender.close().await;
                        tlog!("[ws] Connection {conn_id} timed out (no activity for 60s)");
                    }
                }

                // Send heartbeat to remaining authenticated connections
                for conn in connections.values_mut() {
                    if conn.authenticated {
                        send_or_warn(conn, msg.clone()).await;
                    }
                }
            }

            else => break,
        }
    }

    tlog!("[ws] Connection manager task exiting");
}

fn decrement_refcount(
    refcount: &mut HashMap<u8, usize>,
    channel_map: &mut ChannelMap,
    channel: u8,
) {
    if let Some(count) = refcount.get_mut(&channel) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            refcount.remove(&channel);
            // Grab the session_id before releasing so we can clear its frame offset.
            let session_id = channel_map.channel_to_session.get(&channel).cloned();
            channel_map.release(channel);
            if let Some(sid) = session_id {
                // Remove from shared channel map
                if let Ok(mut map) = CHANNEL_MAP.write() {
                    map.remove(&sid);
                }
                crate::ws::dispatch::clear_frame_offset(&sid);
            }
        }
    }
}

async fn send_or_warn(conn: &mut Connection, msg: Message) {
    if let Err(e) = conn.sender.send(msg).await {
        if !conn.send_warned {
            tlog!("[ws] Send failed (will suppress further warnings): {e}");
            conn.send_warned = true;
        }
    }
}

// ============================================================================
// Accept loop
// ============================================================================

async fn accept_loop(
    listener: TcpListener,
    token: String,
    cmd_tx: mpsc::UnboundedSender<ServerCommand>,
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

                            // Register the write-half with the connection manager
                            let _ = cmd_tx.send(ServerCommand::NewConnection {
                                conn_id,
                                sender: write,
                            });

                            // Run the per-connection read loop
                            connection_read_task(conn_id, read, token, cmd_tx).await;
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

    let _ = cmd_tx.send(ServerCommand::ConnectionClosed { conn_id });
}

// ============================================================================
// Helpers
// ============================================================================

/// Update `last_heartbeat` on all listeners for the given sessions.
/// This bridges the WS keepalive to the IO session watchdog, allowing
/// the frontend to stop sending per-listener `register_session_listener` invoke calls.
async fn touch_listener_heartbeats(session_ids: Vec<String>) {
    crate::io::touch_listener_heartbeats(&session_ids).await;
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

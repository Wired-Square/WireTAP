//! Binary TCP ingest listener: accepts device connections, authenticates the
//! HELLO against the API key store, routes (and auto-creates) the target
//! capture database, and writes each batch to Postgres synchronously — the
//! client is only ACKed once the batch is durably stored (ACK-after-write), so
//! a DB outage back-pressures the device into its own disk cache.

pub mod proto;
pub mod writer;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db::Databases;
use crate::keys::KeyStore;
use proto::*;
use writer::{copy_rows, FrameRow};

#[derive(Debug, Serialize, Clone)]
pub struct IngestSessionInfo {
    pub peer: String,
    pub key_name: String,
    pub database: String,
    pub frames: u64,
    pub batches: u64,
    pub connected_at: DateTime<Utc>,
}

#[derive(Clone, Default)]
pub struct Sessions {
    inner: Arc<Mutex<HashMap<u64, IngestSessionInfo>>>,
    next_id: Arc<AtomicU64>,
}

impl Sessions {
    pub async fn list(&self) -> Vec<IngestSessionInfo> {
        self.inner.lock().await.values().cloned().collect()
    }
}

pub struct IngestServer {
    pub config: Arc<Config>,
    pub dbs: Databases,
    pub keys: KeyStore,
    pub sessions: Sessions,
}

impl IngestServer {
    pub async fn run(self: Arc<Self>) -> Result<(), String> {
        let listener = TcpListener::bind(&self.config.ingest_listen)
            .await
            .map_err(|e| format!("ingest bind {}: {e}", self.config.ingest_listen))?;
        tracing::info!("ingest listening on {}", self.config.ingest_listen);
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    let server = self.clone();
                    tokio::spawn(async move {
                        let peer = peer.to_string();
                        tracing::info!("ingest client {peer} connected");
                        if let Err(e) = server.handle_client(stream, &peer).await {
                            tracing::debug!("ingest client {peer}: {e}");
                        }
                        tracing::info!("ingest client {peer} disconnected");
                    });
                }
                Err(e) => tracing::warn!("ingest accept error: {e}"),
            }
        }
    }

    async fn handle_client(&self, mut stream: TcpStream, peer: &str) -> Result<(), String> {
        let idle_limit = Duration::from_secs_f64(self.config.ingest_keepalive_secs * 3.0);
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut read_buf = [0u8; 65536];
        let mut authed: Option<(Pool, u64, bool)> = None; // (pool, session_id, time_relative)

        let result = loop {
            // Read with idle timeout (any traffic counts as keepalive)
            let n = match tokio::time::timeout(idle_limit, stream.read(&mut read_buf)).await {
                Ok(Ok(0)) => break Ok(()),
                Ok(Ok(n)) => n,
                Ok(Err(e)) => break Err(format!("read: {e}")),
                Err(_) => break Err("idle timeout".into()),
            };
            buf.extend_from_slice(&read_buf[..n]);

            loop {
                let frame = match proto::take_frame(&mut buf) {
                    Ok(Some(f)) => f,
                    Ok(None) => break,
                    Err(e) => return self.finish(authed, Err(e)).await,
                };

                if !frame.crc_ok {
                    // Best effort: a corrupt BATCH can be retried by seq
                    if frame.mtype == MSG_BATCH && frame.body.len() >= 4 {
                        let seq = u32::from_le_bytes(frame.body[0..4].try_into().unwrap());
                        stream
                            .write_all(&proto::encode_ack(seq, ACK_CRC, 0))
                            .await
                            .map_err(|e| format!("write: {e}"))?;
                    }
                    continue;
                }

                match frame.mtype {
                    MSG_HELLO => match self.handle_hello(&frame.body, peer).await {
                        Ok((ack, session)) => {
                            stream.write_all(&ack).await.map_err(|e| format!("write: {e}"))?;
                            match session {
                                Some(s) => authed = Some(s),
                                None => return self.finish(authed, Ok(())).await,
                            }
                        }
                        Err(e) => return self.finish(authed, Err(e)).await,
                    },
                    MSG_PING => {
                        stream
                            .write_all(&proto::encode_message(MSG_PONG, b""))
                            .await
                            .map_err(|e| format!("write: {e}"))?;
                    }
                    MSG_BATCH => {
                        let Some((pool, session_id, time_relative)) = authed.as_ref() else {
                            return self.finish(authed, Err("batch before hello".into())).await;
                        };
                        let ack = self
                            .handle_batch(&frame.body, pool, *session_id, *time_relative)
                            .await;
                        stream.write_all(&ack).await.map_err(|e| format!("write: {e}"))?;
                    }
                    _ => {} // unknown type: ignore (forward compatibility)
                }
            }
        };
        self.finish(authed, result).await
    }

    /// Deregister the session (if any) and pass the result through.
    async fn finish(
        &self,
        authed: Option<(Pool, u64, bool)>,
        result: Result<(), String>,
    ) -> Result<(), String> {
        if let Some((_, session_id, _)) = authed {
            self.sessions.inner.lock().await.remove(&session_id);
        }
        result
    }

    /// Returns the HELLO_ACK to send plus the established session (None when
    /// the ACK is a rejection and the connection should close after sending).
    async fn handle_hello(
        &self,
        body: &[u8],
        peer: &str,
    ) -> Result<(Vec<u8>, Option<(Pool, u64, bool)>), String> {
        let now_us = Utc::now().timestamp_micros() as u64;
        let reject = |status: u8| Ok((proto::encode_hello_ack(status, now_us), None));

        let hello = proto::parse_hello(body).map_err(|e| format!("bad hello: {e}"))?;
        if hello.version != PROTO_VERSION {
            return reject(HELLO_BAD_VERSION);
        }

        let key = String::from_utf8_lossy(&hello.token).into_owned();
        let Some(info) = self.keys.validate(&key).await else {
            tracing::warn!("ingest client {peer} failed auth");
            return reject(HELLO_BAD_AUTH);
        };
        if !info.role.allows_ingest() {
            tracing::warn!("ingest client {peer} key '{}' lacks ingest role", info.name);
            return reject(HELLO_BAD_AUTH);
        }

        // Resolve the target database: explicit > key pin > server default.
        // A pinned key may not name any other database.
        let database = match (&info.database_pin, hello.database.as_str()) {
            (Some(pin), "") => pin.clone(),
            (Some(pin), requested) if requested != pin => {
                tracing::warn!(
                    "ingest client {peer} key '{}' pinned to '{pin}' requested '{requested}'",
                    info.name
                );
                return reject(HELLO_BAD_AUTH);
            }
            (Some(pin), _) => pin.clone(),
            (None, "") => self.dbs.default_database().to_string(),
            (None, requested) => requested.to_string(),
        };

        let pool = match self.dbs.ensure_database(&database, true).await {
            Ok(pool) => pool,
            Err(e) => {
                tracing::warn!("ingest client {peer}: database '{database}': {e}");
                return reject(HELLO_BAD_DATABASE);
            }
        };

        let session_id = self.sessions.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions.inner.lock().await.insert(
            session_id,
            IngestSessionInfo {
                peer: peer.to_string(),
                key_name: info.name,
                database: database.clone(),
                frames: 0,
                batches: 0,
                connected_at: Utc::now(),
            },
        );
        tracing::info!("ingest client {peer} authenticated, database '{database}'");
        Ok((
            proto::encode_hello_ack(HELLO_OK, now_us),
            Some((pool, session_id, hello.time_relative)),
        ))
    }

    /// Write one batch to Postgres, then ACK. The client only treats frames as
    /// delivered once they are durably stored; a DB failure yields ACK_OVERLOADED
    /// so the device caches and retries (no frames are buffered in gateway RAM).
    async fn handle_batch(
        &self,
        body: &[u8],
        pool: &Pool,
        session_id: u64,
        time_relative: bool,
    ) -> Vec<u8> {
        let batch = match proto::parse_batch(body, self.config.ingest_max_batch_frames) {
            None => return proto::encode_ack(0, ACK_MALFORMED, 0),
            Some(Err(seq)) => return proto::encode_ack(seq, ACK_MALFORMED, 0),
            Some(Ok(b)) => b,
        };

        // TIME_RELATIVE: stamp the last record at arrival, back-date the rest
        let base_ts_us = if time_relative {
            let last_delta = batch.records.last().map(|r| r.delta_us as i64).unwrap_or(0);
            Utc::now().timestamp_micros() - last_delta
        } else {
            batch.base_ts_us as i64
        };

        let seq = batch.seq;
        let rows: Vec<FrameRow> = batch
            .records
            .into_iter()
            .map(|rec| {
                let is_fd = rec.id_flags & ID_FD != 0;
                let plen = rec.payload.len();
                FrameRow {
                    ts_us: base_ts_us + rec.delta_us as i64,
                    id: rec.id_flags & ID_ARB_MASK,
                    extended: rec.id_flags & ID_EXTENDED != 0,
                    dlc: if is_fd { proto::len_to_dlc(plen) } else { plen.min(8) as u8 },
                    is_fd,
                    data: rec.payload,
                    bus: rec.bus,
                    dir_tx: rec.id_flags & ID_TX != 0,
                }
            })
            .collect();
        let count = rows.len() as u64;

        match copy_rows(pool, &rows).await {
            Ok(()) => {
                if let Some(s) = self.sessions.inner.lock().await.get_mut(&session_id) {
                    s.frames += count;
                    s.batches += 1;
                }
                proto::encode_ack(seq, ACK_OK, 0)
            }
            Err(e) => {
                tracing::warn!("ingest write failed (seq {seq}): {e}");
                proto::encode_ack(seq, ACK_OVERLOADED, 0)
            }
        }
    }
}

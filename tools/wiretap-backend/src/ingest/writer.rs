//! Synchronous batch writer: COPY a slice of frames into public.can_frame.
//!
//! The ingest path writes each batch to PostgreSQL inline and only ACKs the
//! client on success (ACK-after-write), so a DB outage immediately
//! back-pressures the device, which then caches durably and retries. There is
//! deliberately no in-process queue — durability lives at the device's disk
//! cache and in PostgreSQL, never in gateway RAM. Also used by the HTTP
//! capture-import endpoint, which manages its own chunking.

use std::fmt::Write as _;

use bytes::Bytes;
use chrono::DateTime;
use deadpool_postgres::Pool;
use futures_util::SinkExt;

#[derive(Debug)]
pub struct FrameRow {
    pub ts_us: i64,
    pub id: u32,
    pub extended: bool,
    pub dlc: u8,
    pub is_fd: bool,
    pub data: Vec<u8>,
    pub bus: u8,
    pub dir_tx: bool,
}

/// COPY a slice of rows into public.can_frame.
pub async fn copy_rows(pool: &Pool, batch: &[FrameRow]) -> Result<(), String> {
    let client = pool.get().await.map_err(|e| format!("pool: {e}"))?;
    let sink = client
        .copy_in(
            "COPY public.can_frame (ts, id, extended, dlc, is_fd, data_bytes, bus, dir) \
             FROM STDIN",
        )
        .await
        .map_err(|e| format!("copy_in: {e}"))?;
    futures_util::pin_mut!(sink);

    let mut buf = String::with_capacity(batch.len() * 64);
    for row in batch {
        let ts = DateTime::from_timestamp_micros(row.ts_us)
            .ok_or_else(|| format!("timestamp out of range: {}", row.ts_us))?;
        // COPY text format: literal backslash is escaped, so bytea hex input
        // (\x…) is written as \\x…
        let _ = write!(
            buf,
            "{}\t{}\t{}\t{}\t{}\t\\\\x{}\t{}\t{}\n",
            ts.format("%Y-%m-%dT%H:%M:%S%.6f+00:00"),
            row.id,
            if row.extended { 't' } else { 'f' },
            row.dlc,
            if row.is_fd { 't' } else { 'f' },
            hex::encode(&row.data),
            row.bus,
            if row.dir_tx { "tx" } else { "rx" },
        );
    }
    sink.send(Bytes::from(buf)).await.map_err(|e| format!("copy send: {e}"))?;
    sink.finish().await.map_err(|e| format!("copy finish: {e}"))?;
    Ok(())
}

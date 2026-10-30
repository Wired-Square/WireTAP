// ui/crates/wiretap-app/src/capture_db.rs
//
// The app's capture database, `buffers.db`, as a `wiretap_capture_store::Store`.
// Metadata lives in RAM in capture_store.rs; this is the storage behind it.
//
// Schema changes MUST be recorded migrations in wiretap-capture-store — see that
// crate's README. Never issue ad-hoc DDL from feature code.

use std::future::Future;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use sqlx::sqlite::SqliteRow;
use wiretap_analysis::order::TimedFrame;
use wiretap_analysis::source::{
    FrameSelection, FrameSource, InventoryRow, PayloadQuery, PayloadSource, Source, SourceFrame,
};
use wiretap_analysis::FrameKey;
use wiretap_capture_store::{
    Cancel, CaptureError, Direction, FrameRecord, NewCaptureEvent, Sql, Store, StoredFrame,
};

use crate::capture_events::CaptureEvent;
use crate::capture_store::{CaptureFrameInfo, CaptureKind, CaptureMetadata, TimestampedByte};
use crate::io::FrameMessage;

static STORE: OnceLock<Store> = OnceLock::new();

#[cfg(test)]
thread_local! {
    pub(crate) static LENT: std::cell::RefCell<Option<Store>> = const { std::cell::RefCell::new(None) };
}

fn store() -> Result<Store, String> {
    #[cfg(test)]
    if let Some(lent) = LENT.with_borrow(Clone::clone) {
        return Ok(lent);
    }
    STORE.get().cloned().ok_or_else(|| "Database not initialised".to_string())
}

/// The store's own messages stand alone; a SQLite error says what was being done.
fn failed_to(action: &str) -> impl FnOnce(CaptureError) -> String + '_ {
    move |e| match e {
        CaptureError::Sqlite(_) | CaptureError::Database(_) => format!("Failed to {action}: {e}"),
        e => e.to_string(),
    }
}

pub use crate::blocking::wait;

impl FrameRecord for FrameMessage {
    fn protocol(&self) -> &str {
        &self.protocol
    }
    fn timestamp_us(&self) -> u64 {
        self.timestamp_us
    }
    fn frame_id(&self) -> u32 {
        self.frame_id
    }
    fn bus(&self) -> u8 {
        self.bus
    }
    fn length(&self) -> u16 {
        self.dlc
    }
    fn payload(&self) -> &[u8] {
        &self.bytes
    }
    fn extended(&self) -> bool {
        self.is_extended
    }
    fn fd(&self) -> bool {
        self.is_fd
    }
    fn rtr(&self) -> bool {
        self.is_rtr
    }
    fn brs(&self) -> bool {
        self.is_brs
    }
    fn esi(&self) -> bool {
        self.is_esi
    }
    fn source_address(&self) -> Option<u16> {
        self.source_address
    }
    fn incomplete(&self) -> Option<bool> {
        self.incomplete
    }
    fn crc_valid(&self) -> Option<bool> {
        self.crc_valid
    }
    fn direction(&self) -> Option<Direction> {
        match self.direction.as_deref()? {
            "rx" => Some(Direction::Rx),
            "tx" => Some(Direction::Tx),
            _ => None,
        }
    }
}

impl From<StoredFrame> for FrameMessage {
    fn from(f: StoredFrame) -> Self {
        FrameMessage {
            protocol: f.protocol,
            timestamp_us: f.timestamp_us,
            frame_id: f.frame_id,
            bus: f.bus,
            dlc: f.len,
            bytes: f.payload,
            is_extended: f.extended,
            is_fd: f.fd,
            is_rtr: f.rtr,
            is_brs: f.brs,
            is_esi: f.esi,
            source_address: f.source_address,
            incomplete: f.incomplete,
            direction: f.direction.map(|d| match d {
                Direction::Rx => "rx".into(),
                Direction::Tx => "tx".into(),
            }),
            crc_valid: f.crc_valid,
        }
    }
}

impl From<wiretap_capture_store::CaptureEvent> for CaptureEvent {
    fn from(e: wiretap_capture_store::CaptureEvent) -> Self {
        CaptureEvent {
            id: e.id.to_string(),
            timestamp_us: e.ts_us,
            duration_us: e.duration_us,
            note: e.note,
            created_at_us: e.created_at_us,
            updated_at_us: e.updated_at_us,
        }
    }
}

fn messages(frames: Vec<StoredFrame>) -> Vec<FrameMessage> {
    frames.into_iter().map(FrameMessage::from).collect()
}

fn messages_with_rowids(rows: Vec<(i64, StoredFrame)>) -> Vec<(i64, FrameMessage)> {
    rows.into_iter()
        .map(|(rowid, f)| (rowid, f.into()))
        .collect()
}

// ============================================================================
// Initialisation
// ============================================================================

/// Initialise the capture database. Must be called once at app startup.
/// When `clear_on_start` is true, leftover data from previous sessions is deleted.
pub fn initialise(app_data_dir: &Path, clear_on_start: bool) -> Result<(), String> {
    let db_path = app_data_dir.join("buffers.db");
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    let store = wait(async {
        let (store, applied) = Store::open(&db_path).await.map_err(|e| match e {
            CaptureError::NewerFile { found, known } => format!(
                "it was written by a newer WireTAP (file version {found}; this one reads up to {known}) \
                 and has been left untouched. Update WireTAP to open it"
            ),
            e => failed_to("open the capture database")(e),
        })?;
        for m in applied {
            tlog!("[capture_db] Applied migration {} ({})", m.version, m.name);
        }
        if clear_on_start {
            store
                .sweep_non_persistent()
                .await
                .map_err(failed_to("clear non-persistent captures"))?;
        }
        Ok::<_, String>(store)
    })?;
    tlog!(
        "[capture_db] Initialised at {:?} ({})",
        db_path,
        if clear_on_start { "cleared non-persistent and vacuumed" } else { "preserving previous data" }
    );
    STORE.set(store).map_err(|_| "Capture database already initialised".to_string())
}

/// A file, not memory: a pooled connection returns on a task of the runtime that dropped
/// it, so tests on many runtimes can lose one, and an in-memory database dies with it.
#[cfg(test)]
pub(crate) async fn scratch_store() -> Store {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("wiretap-capture-store-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Store::open(dir.join(format!("{n}.db"))).await.unwrap().0
}

/// The one database every test shares; for a test whose work leaves its thread.
#[cfg(test)]
pub(crate) fn use_in_memory_database() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let _ = STORE.set(wait(scratch_store()));
    });
}

/// While held, this thread's store calls, and the `wait`s it makes, use its own store.
#[cfg(test)]
#[must_use]
pub(crate) struct OwnStore;

#[cfg(test)]
impl Drop for OwnStore {
    fn drop(&mut self) {
        LENT.set(None);
    }
}

/// `store` stands in for the database on this test's thread until the guard drops;
/// any other thread still reaches the shared one.
#[cfg(test)]
pub(crate) fn use_own_store(store: Store) -> OwnStore {
    LENT.set(Some(store));
    OwnStore
}

#[cfg(test)]
pub(crate) fn use_own_database() -> OwnStore {
    use_own_store(wait(scratch_store()))
}

#[cfg(test)]
pub(crate) fn current() -> Store {
    store().expect("a test database")
}

/// A capture as the analysis levers read it.
pub struct Capture {
    store: Store,
    id: String,
}

/// Runs `read` over capture `id`.
pub async fn analyse<T>(id: &str, read: impl AsyncFnOnce(&Capture) -> T) -> Result<T, String> {
    let capture = Capture {
        store: store()?,
        id: id.to_owned(),
    };
    Ok(read(&capture).await)
}

/// What a capture source's error reads as.
pub fn source_error(e: CaptureError) -> String {
    failed_to("read the capture")(e)
}

/// Frames read a page at a time, so a whole capture is never one query.
const FRAME_PAGE: usize = 50_000;

impl Capture {
    async fn selected(&self, selection: &FrameSelection, newest: Option<usize>) -> Result<Vec<StoredFrame>, CaptureError> {
        let (store, id) = (&self.store, self.id.as_str());
        if selection.is_empty() {
            if let Some(n) = newest {
                return Ok(store.get_frames_tail_rows(id, n).await?.0);
            }
        }
        if let Some(n) = newest {
            return Ok(store.get_frames_tail_filtered(id, n, selection).await?.0);
        }
        let mut frames = Vec::new();
        loop {
            let (page, _, total) = store.get_frames_paginated_filtered(id, frames.len(), FRAME_PAGE, selection).await?;
            let done = page.is_empty() || frames.len() + page.len() >= total;
            frames.extend(page);
            if done {
                return Ok(frames);
            }
        }
    }
}

impl Source for Capture {
    type Error = CaptureError;
}

impl PayloadSource for Capture {
    async fn inventory(&self, start_us: Option<i64>, end_us: Option<i64>) -> Result<Vec<InventoryRow>, CaptureError> {
        self.store.frame_inventory(&self.id, start_us, end_us).await
    }

    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, CaptureError> {
        self.store.payloads(&self.id, &q).await
    }
}

impl FrameSource for Capture {
    async fn frames(&self, selection: &FrameSelection, newest: Option<usize>) -> Result<Vec<SourceFrame>, CaptureError> {
        Ok(self
            .selected(selection, newest)
            .await?
            .into_iter()
            .map(|f| SourceFrame {
                frame: TimedFrame {
                    bus: f.bus,
                    key: FrameKey::new(f.frame_id, f.extended),
                    timestamp_us: f.timestamp_us,
                    payload: f.payload,
                },
                protocol: f.protocol,
            })
            .collect())
    }
}

// ============================================================================
// Writes
// ============================================================================

/// The waits between attempts at an insert refused by another writer's lock or a full pool.
const INSERT_RETRY_BACKOFF: [Duration; 3] = [Duration::from_millis(50), Duration::from_millis(200), Duration::from_millis(800)];

fn is_contention(e: &CaptureError) -> bool {
    const SQLITE_BUSY: i32 = 5;
    const SQLITE_LOCKED: i32 = 6;
    match e {
        CaptureError::Sqlite(sqlx::Error::PoolTimedOut) => true,
        CaptureError::Sqlite(sqlx::Error::Database(db)) => db
            .code()
            .and_then(|code| code.parse::<i32>().ok())
            .is_some_and(|code| matches!(code & 0xFF, SQLITE_BUSY | SQLITE_LOCKED)),
        _ => false,
    }
}

/// An insert is one transaction, so a refused one stored nothing and can run again.
async fn insert_retrying<F: Future<Output = Result<(), CaptureError>>>(
    action: &str,
    insert: impl Fn() -> F,
) -> Result<(), String> {
    for backoff in INSERT_RETRY_BACKOFF {
        match insert().await {
            Err(e) if is_contention(&e) => {
                tlog!("[capture_db] Retrying a refused insert in {backoff:?}: {e}");
                tokio::time::sleep(backoff).await;
            }
            done => return done.map_err(failed_to(action)),
        }
    }
    insert().await.map_err(failed_to(action))
}

pub async fn insert_frames(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    let store = &store()?;
    insert_retrying("insert frames", || store.insert_frames(capture_id, frames)).await
}

pub async fn insert_bytes(capture_id: &str, bytes: &[TimestampedByte]) -> Result<(), String> {
    let store = &store()?;
    insert_retrying("insert bytes", || store.insert_bytes(capture_id, bytes)).await
}

/// Clear and refill a capture with new frames (used by framing to reuse capture IDs).
pub async fn clear_and_refill(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    store()?.clear_and_refill(capture_id, frames).await.map_err(failed_to("refill the capture"))
}

pub async fn copy_capture_data(source_id: &str, dest_id: &str) -> Result<usize, String> {
    store()?.copy_capture_data(source_id, dest_id).await.map_err(failed_to("copy the capture"))
}

pub async fn delete_capture_data(capture_id: &str) -> Result<(), String> {
    store()?.delete_capture_data(capture_id).await.map_err(failed_to("delete capture data"))
}

// ============================================================================
// Frame reads
// ============================================================================

/// Returns (frames, rowids).
pub async fn get_frames_paginated(
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let (frames, rowids) = store()?
        .get_frames_paginated(capture_id, offset, limit)
        .await
        .map_err(failed_to("read frames"))?;
    Ok((messages(frames), rowids))
}

/// Returns (frames, rowids, total_filtered_count).
pub async fn get_frames_paginated_filtered(
    capture_id: &str,
    offset: usize,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let (frames, rowids, total) = store()?
        .get_frames_paginated_filtered(capture_id, offset, limit, selection)
        .await
        .map_err(failed_to("read frames"))?;
    Ok((messages(frames), rowids, total))
}

/// The last `limit` frames, oldest first, with their rowids; the caller has the total.
pub async fn get_frames_tail_rows(capture_id: &str, limit: usize) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let (frames, rowids) = store()?
        .get_frames_tail_rows(capture_id, limit)
        .await
        .map_err(failed_to("read frames"))?;
    Ok((messages(frames), rowids))
}

/// The last `limit` selected frames, oldest first; returns (frames, rowids, total_matching).
pub async fn get_frames_tail_filtered(
    capture_id: &str,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let (frames, rowids, total) = store()?
        .get_frames_tail_filtered(capture_id, limit, selection)
        .await
        .map_err(failed_to("read frames"))?;
    Ok((messages(frames), rowids, total))
}

pub async fn get_frame_count(capture_id: &str) -> Result<usize, String> {
    store()?.get_frame_count(capture_id).await.map_err(failed_to("count frames"))
}

pub async fn non_can_protocols(capture_id: &str) -> Result<Vec<String>, String> {
    store()?.non_can_protocols(capture_id).await.map_err(failed_to("read capture protocols"))
}

pub async fn get_frame_info(capture_id: &str) -> Result<Vec<CaptureFrameInfo>, String> {
    store()?.get_frame_info(capture_id).await.map_err(failed_to("read frame info"))
}

pub async fn find_offset_for_timestamp(
    capture_id: &str,
    target_us: u64,
    selection: &FrameSelection,
) -> Result<usize, String> {
    store()?
        .find_offset_for_timestamp(capture_id, target_us, selection)
        .await
        .map_err(failed_to("find a frame by time"))
}

/// Offsets of the matching frames among the selected ones; `query` arrives stripped of whitespace.
pub async fn search_frames(
    capture_id: &str,
    query: &str,
    search_id: bool,
    search_data: bool,
    selection: &FrameSelection,
) -> Result<Vec<usize>, String> {
    store()?
        .search_frames(capture_id, query, search_id, search_data, selection)
        .await
        .map_err(failed_to("search frames"))
}

pub async fn get_all_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    store()?.get_all_frames(capture_id).await.map(messages).map_err(failed_to("read frames"))
}

pub async fn get_latest_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    store()?.get_latest_frames(capture_id).await.map(messages).map_err(failed_to("read frames"))
}

pub async fn read_frame_chunk(capture_id: &str, after_rowid: i64, limit: usize) -> Result<Vec<(i64, FrameMessage)>, String> {
    store()?
        .read_frame_chunk(capture_id, after_rowid, limit)
        .await
        .map(messages_with_rowids)
        .map_err(failed_to("read frames"))
}

pub async fn read_frame_chunk_reverse(
    capture_id: &str,
    before_rowid: i64,
    limit: usize,
) -> Result<Vec<(i64, FrameMessage)>, String> {
    store()?
        .read_frame_chunk_reverse(capture_id, before_rowid, limit)
        .await
        .map(messages_with_rowids)
        .map_err(failed_to("read frames"))
}

pub async fn get_rowid_range(capture_id: &str) -> Result<Option<(i64, i64)>, String> {
    store()?.get_rowid_range(capture_id).await.map_err(failed_to("read frames"))
}

pub async fn find_rowid_for_timestamp(capture_id: &str, timestamp_us: u64) -> Result<Option<i64>, String> {
    store()?
        .find_rowid_for_timestamp(capture_id, timestamp_us)
        .await
        .map_err(failed_to("find a frame by time"))
}

pub async fn get_frame_at_index(capture_id: &str, index: usize) -> Result<Option<(i64, FrameMessage)>, String> {
    store()?
        .get_frame_at_index(capture_id, index)
        .await
        .map(|row| row.map(|(rowid, f)| (rowid, f.into())))
        .map_err(failed_to("read frames"))
}

/// Returns (rowid, frame_index, frame).
pub async fn get_next_filtered_frame(
    capture_id: &str,
    current_rowid: i64,
    selection: &FrameSelection,
    backward: bool,
) -> Result<Option<(i64, usize, FrameMessage)>, String> {
    store()?
        .get_next_filtered_frame(capture_id, current_rowid, selection, backward)
        .await
        .map(|row| row.map(|(rowid, index, f)| (rowid, index, f.into())))
        .map_err(failed_to("read frames"))
}

pub async fn count_frames_before_rowid(capture_id: &str, rowid: i64) -> Result<usize, String> {
    store()?.count_frames_before_rowid(capture_id, rowid).await.map_err(failed_to("count frames"))
}

// ============================================================================
// Byte reads
// ============================================================================

/// Returns (bytes, total_count).
pub async fn get_bytes_paginated(
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<TimestampedByte>, usize), String> {
    store()?.get_bytes_paginated(capture_id, offset, limit).await.map_err(failed_to("read bytes"))
}

/// The last `limit` bytes, oldest first; the caller has the total.
pub async fn get_bytes_tail_rows(capture_id: &str, limit: usize) -> Result<Vec<TimestampedByte>, String> {
    store()?.get_bytes_tail_rows(capture_id, limit).await.map_err(failed_to("read bytes"))
}

pub async fn get_all_bytes(capture_id: &str) -> Result<Vec<TimestampedByte>, String> {
    store()?.get_all_bytes(capture_id).await.map_err(failed_to("read bytes"))
}

pub async fn find_bytes_offset_for_timestamp(capture_id: &str, target_us: u64) -> Result<usize, String> {
    store()?
        .find_bytes_offset_for_timestamp(capture_id, target_us)
        .await
        .map_err(failed_to("find a byte by time"))
}

/// Run a read-only `statement`, one `T` per row. Setting `cancel` aborts it
/// between SQLite VM steps.
pub async fn read_rows<T: Send + Unpin>(
    statement: &Sql,
    cancel: &Cancel,
    map: impl FnMut(&SqliteRow) -> sqlx::Result<T> + Send,
) -> Result<Vec<T>, String> {
    store()?.read_rows(statement, cancel, map).await.map_err(failed_to("run the query"))
}

// ============================================================================
// Capture metadata
// ============================================================================

pub async fn save_capture_metadata(meta: &CaptureMetadata) -> Result<(), String> {
    store()?.save_capture_metadata(meta).await.map_err(failed_to("save capture metadata"))
}

pub async fn load_all_capture_metadata() -> Result<Vec<CaptureMetadata>, String> {
    store()?.load_all_capture_metadata().await.map_err(failed_to("load capture metadata"))
}

pub async fn update_capture_name(capture_id: &str, new_name: &str) -> Result<(), String> {
    store()?.update_capture_name(capture_id, new_name).await.map_err(failed_to("update capture name"))
}

pub async fn update_capture_persistent(capture_id: &str, persistent: bool) -> Result<(), String> {
    store()?
        .update_capture_persistent(capture_id, persistent)
        .await
        .map_err(failed_to("update capture persistent flag"))
}

/// Backfills the buses of a capture stored before they were tracked.
pub async fn get_distinct_buses(capture_id: &str, kind: CaptureKind) -> Result<Vec<u8>, String> {
    store()?.get_distinct_buses(capture_id, kind).await.map_err(failed_to("read capture buses"))
}

pub async fn delete_capture_metadata(capture_id: &str) -> Result<(), String> {
    store()?.delete_capture_metadata(capture_id).await.map_err(failed_to("delete capture metadata"))
}

// ============================================================================
// Capture events
// ============================================================================

fn parse_event_id(id: &str) -> Result<i64, String> {
    id.parse().map_err(|_| format!("Invalid event id '{id}'"))
}

fn new_event(timestamp_us: i64, duration_us: i64, note: &str) -> NewCaptureEvent {
    NewCaptureEvent {
        ts_us: timestamp_us,
        duration_us,
        note: note.into(),
    }
}

pub async fn list_capture_events(capture_id: &str) -> Result<Vec<CaptureEvent>, String> {
    store()?
        .list_capture_events(capture_id)
        .await
        .map(|events| events.into_iter().map(CaptureEvent::from).collect())
        .map_err(failed_to("read events"))
}

pub async fn insert_capture_event(
    capture_id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    store()?
        .insert_capture_event(capture_id, &new_event(timestamp_us, duration_us, note))
        .await
        .map(CaptureEvent::from)
        .map_err(failed_to("insert event"))
}

pub async fn update_capture_event(
    capture_id: &str,
    id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let id = parse_event_id(id)?;
    store()?
        .update_capture_event(capture_id, id, &new_event(timestamp_us, duration_us, note))
        .await
        .map(CaptureEvent::from)
        .map_err(failed_to("update event"))
}

pub async fn delete_capture_event(capture_id: &str, id: &str) -> Result<(), String> {
    let id = parse_event_id(id)?;
    store()?.delete_capture_event(capture_id, id).await.map_err(failed_to("delete event"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_database_from_a_newer_wiretap_is_refused_and_left_as_it_is() {
        use sqlx::{ConnectOptions, Connection, Executor};
        let dir = std::env::temp_dir().join(format!("wiretap-newer-capture-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("buffers.db");
        wait(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            conn.execute("CREATE TABLE frames (capture_id TEXT); PRAGMA user_version = 99").await.unwrap();
            conn.close().await.unwrap();
        });
        let before = std::fs::read(&db_path).unwrap();

        let error = initialise(&dir, true).unwrap_err();

        assert!(error.contains("written by a newer WireTAP (file version 99"), "{error}");
        assert_eq!(std::fs::read(&db_path).unwrap(), before);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_frame_message_round_trips_through_the_store() {
        let _db = use_own_store(scratch_store().await);
        let can = |frame_id, dlc, bytes: Vec<u8>, direction: Option<&str>| FrameMessage {
            protocol: "can".into(),
            timestamp_us: frame_id as u64,
            frame_id,
            bus: 1,
            dlc,
            bytes,
            direction: direction.map(Into::into),
            ..Default::default()
        };
        let frames = vec![
            FrameMessage {
                is_rtr: true,
                ..can(0x100, 6, vec![], None)
            },
            FrameMessage {
                is_fd: true,
                is_brs: true,
                is_esi: true,
                is_extended: true,
                ..can(0x101, 2, vec![1, 2], Some("tx"))
            },
            FrameMessage {
                source_address: Some(0x2A),
                incomplete: Some(true),
                ..can(0x102, 1, vec![3], Some("rx"))
            },
            FrameMessage {
                protocol: wslib_wiretap_protocol::ingest::MODBUS_RTU_PROTOCOL.into(),
                crc_valid: Some(false),
                ..can(0x0103, 4, vec![1, 3, 0xAA, 0xBB], None)
            },
        ];
        insert_frames("c1", &frames).await.unwrap();

        let json = |frames: &[FrameMessage]| serde_json::to_value(frames).unwrap();
        assert_eq!(json(&get_all_frames("c1").await.unwrap()), json(&frames));
    }

    #[tokio::test]
    async fn a_store_error_says_what_failed_and_its_own_messages_stand_alone() {
        let bare = wslib_db_sqlite::Database::open_in_memory(&[]).await.unwrap();
        let db = use_own_store(Store::from_database(bare));
        let error = get_frame_count("c1").await.unwrap_err();
        assert_eq!(error, "Failed to count frames: no such table: frames");
        drop(db);
        let _db = use_own_store(scratch_store().await);
        assert_eq!(delete_capture_event("c1", "7").await, Err("Event not found".into()));
        assert_eq!(delete_capture_event("c1", "x").await, Err("Invalid event id 'x'".into()));
    }

    #[test]
    fn a_sync_caller_waits_on_its_own_store() {
        let _db = use_own_database();
        wait(insert_frames("c1", &[FrameMessage { protocol: "can".into(), ..Default::default() }])).unwrap();
        assert_eq!(wait(get_frame_count("c1")), Ok(1));
    }

    #[tokio::test]
    async fn a_sync_caller_inside_a_runtime_waits_without_nesting_it() {
        let _db = use_own_store(scratch_store().await);
        assert_eq!(wait(get_frame_count("c1")), Ok(0));
    }

    /// Opens only a copy: never a file named like the app's database, nor anything under
    /// the data directory every app identifier's database lives in.
    /// `WIRETAP_CAPTURE_DB_COPY=<copy> cargo test -p wiretap --lib a_copied_capture_db -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn a_copied_capture_db_migrates_and_reads_unchanged() {
        let path = std::env::var("WIRETAP_CAPTURE_DB_COPY").expect("WIRETAP_CAPTURE_DB_COPY names a copy");
        let path = std::fs::canonicalize(path).expect("the copy exists");
        let data = dirs::data_dir()
            .and_then(|d| std::fs::canonicalize(d).ok())
            .expect("a data directory");
        assert!(
            !path.starts_with(&data),
            "refusing {path:?}: it is under {data:?}, where the app's databases live"
        );
        assert_ne!(path.file_name(), Some("buffers.db".as_ref()), "refusing {path:?}: copy it to another name");

        let (store, applied) = Store::open(&path).await.unwrap();
        for m in applied {
            println!("applied migration {} ({})", m.version, m.name);
        }
        let captures = store.load_all_capture_metadata().await.unwrap();
        println!("captures: {}", captures.len());
        for meta in &captures {
            match meta.kind {
                CaptureKind::Frames => {
                    let inventory = store.frame_inventory(&meta.id, None, None).await.unwrap();
                    let (page, _) = store.get_frames_paginated(&meta.id, 0, 50).await.unwrap();
                    let count = store.get_frame_count(&meta.id).await.unwrap();
                    println!("frames: {count} rows, {} identities, first page {}", inventory.len(), page.len());
                }
                CaptureKind::Bytes => {
                    let (page, count) = store.get_bytes_paginated(&meta.id, 0, 50).await.unwrap();
                    println!("bytes: {count} rows, first page {}", page.len());
                }
            }
        }
        store.close().await;
        let (_, applied) = Store::open(&path).await.expect("a second open succeeds");
        assert!(applied.is_empty(), "a second open applies nothing");
    }
}

// ui/crates/wiretap-app/src/capture_db.rs
//
// The app's one connection to the capture database, `buffers.db`, and the
// `wiretap_capture` store read and written through it. Metadata lives in RAM in
// capture_store.rs; this is the storage behind it.
//
// Schema changes MUST be recorded migrations in wiretap-capture — see that
// crate's README. Never issue ad-hoc DDL from feature code.

use rusqlite::Connection;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use wiretap_analysis::source::FrameSelection;
use wiretap_capture::{CaptureError, CaptureSource, Direction, FrameRecord, StoredFrame};
use wiretap_gateway::{NewEvent, Sql};

use crate::blocking::off_runtime;
use crate::capture_events::CaptureEvent;
use crate::capture_store::{CaptureFrameInfo, CaptureKind, CaptureMetadata, TimestampedByte};
use crate::connection_slot::ConnectionSlot;
use crate::io::FrameMessage;

static DB: ConnectionSlot = ConnectionSlot::new();

/// The store's own messages stand alone; a SQLite error says what was being done.
fn failed_to(action: &str) -> impl FnOnce(CaptureError) -> String + '_ {
    move |e| match e {
        CaptureError::Sqlite(_) => format!("Failed to {action}: {e}"),
        e => e.to_string(),
    }
}

fn with<T>(
    action: &str,
    f: impl FnOnce(&mut Connection) -> Result<T, CaptureError>,
) -> Result<T, String> {
    DB.with(|conn| f(conn).map_err(failed_to(action)))
}

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
    DB.open(&db_path, "capture database", |conn| {
        for m in
            wiretap_capture::migrate(conn).map_err(failed_to("migrate the capture database"))?
        {
            tlog!("[capture_db] Applied migration {} ({})", m.version, m.name);
        }
        if clear_on_start {
            wiretap_capture::sweep_non_persistent(conn)
                .map_err(failed_to("clear non-persistent captures"))?;
            tlog!(
                "[capture_db] Initialised at {:?} (cleared non-persistent and vacuumed)",
                db_path
            );
        } else {
            tlog!(
                "[capture_db] Initialised at {:?} (preserving previous data)",
                db_path
            );
        }
        wiretap_capture::tune(conn).map_err(failed_to("tune the capture database"))
    })
}

#[cfg(test)]
pub(crate) fn in_memory() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    wiretap_capture::migrate(&mut conn).unwrap();
    conn
}

/// The one database every test shares; for a test whose work leaves its thread.
#[cfg(test)]
pub(crate) fn use_in_memory_database() {
    DB.install_once(in_memory);
}

/// `conn` stands in for the database on this test's thread until the guard drops;
/// any other thread still reaches the shared one.
#[cfg(test)]
pub(crate) fn use_own_connection(conn: Connection) -> crate::connection_slot::ThreadConnection {
    DB.lend_to_this_thread(conn)
}

#[cfg(test)]
pub(crate) fn use_own_database() -> crate::connection_slot::ThreadConnection {
    use_own_connection(in_memory())
}

#[cfg(test)]
pub(crate) fn trace_statements(trace: Option<fn(rusqlite::trace::TraceEvent<'_>)>) {
    DB.with(|conn| {
        conn.trace_v2(rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT, trace);
        Ok(())
    })
    .expect("database");
}

/// A capture as the analysis levers read it.
pub type Capture = CaptureSource<Arc<Mutex<Connection>>>;

/// Runs `read` over capture `id` on the blocking pool: a capture's reads block
/// under their async signatures.
pub async fn analyse<T: Send + 'static>(
    id: &str,
    read: impl AsyncFnOnce(&Capture) -> T + Send + 'static,
) -> Result<T, String> {
    let capture = Capture {
        conn: DB.shared()?,
        id: id.to_owned(),
    };
    Ok(off_runtime(move || futures::executor::block_on(read(&capture))).await)
}

/// What a capture source's error reads as.
pub fn source_error(e: CaptureError) -> String {
    failed_to("read the capture")(e)
}

// ============================================================================
// Writes
// ============================================================================

pub fn insert_frames(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    with("insert frames", |c| {
        wiretap_capture::insert_frames(c, capture_id, frames)
    })
}

pub fn insert_bytes(capture_id: &str, bytes: &[TimestampedByte]) -> Result<(), String> {
    with("insert bytes", |c| {
        wiretap_capture::insert_bytes(c, capture_id, bytes)
    })
}

/// Clear and refill a capture with new frames (used by framing to reuse capture IDs).
pub fn clear_and_refill(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    with("refill the capture", |c| {
        wiretap_capture::clear_and_refill(c, capture_id, frames)
    })
}

pub fn copy_capture_data(source_id: &str, dest_id: &str) -> Result<usize, String> {
    with("copy the capture", |c| {
        wiretap_capture::copy_capture_data(c, source_id, dest_id)
    })
}

pub fn delete_capture_data(capture_id: &str) -> Result<(), String> {
    with("delete capture data", |c| {
        wiretap_capture::delete_capture_data(c, capture_id)
    })
}

// ============================================================================
// Frame reads
// ============================================================================

/// Returns (frames, rowids).
pub fn get_frames_paginated(
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let (frames, rowids) = with("read frames", |c| {
        wiretap_capture::get_frames_paginated(c, capture_id, offset, limit)
    })?;
    Ok((messages(frames), rowids))
}

/// Returns (frames, rowids, total_filtered_count).
pub fn get_frames_paginated_filtered(
    capture_id: &str,
    offset: usize,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let (frames, rowids, total) = with("read frames", |c| {
        wiretap_capture::get_frames_paginated_filtered(c, capture_id, offset, limit, selection)
    })?;
    Ok((messages(frames), rowids, total))
}

/// The last `limit` frames, oldest first, with their rowids; the caller has the total.
pub fn get_frames_tail_rows(
    capture_id: &str,
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let (frames, rowids) = with("read frames", |c| {
        wiretap_capture::get_frames_tail_rows(c, capture_id, limit)
    })?;
    Ok((messages(frames), rowids))
}

/// The last `limit` selected frames, oldest first; returns (frames, rowids, total_matching).
pub fn get_frames_tail_filtered(
    capture_id: &str,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let (frames, rowids, total) = with("read frames", |c| {
        wiretap_capture::get_frames_tail_filtered(c, capture_id, limit, selection)
    })?;
    Ok((messages(frames), rowids, total))
}

pub fn get_frame_count(capture_id: &str) -> Result<usize, String> {
    with("count frames", |c| {
        wiretap_capture::get_frame_count(c, capture_id)
    })
}

pub fn non_can_protocols(capture_id: &str) -> Result<Vec<String>, String> {
    with("read capture protocols", |c| {
        wiretap_capture::non_can_protocols(c, capture_id)
    })
}

pub fn get_frame_info(capture_id: &str) -> Result<Vec<CaptureFrameInfo>, String> {
    with("read frame info", |c| {
        wiretap_capture::get_frame_info(c, capture_id)
    })
}

pub fn find_offset_for_timestamp(
    capture_id: &str,
    target_us: u64,
    selection: &FrameSelection,
) -> Result<usize, String> {
    with("find a frame by time", |c| {
        wiretap_capture::find_offset_for_timestamp(c, capture_id, target_us, selection)
    })
}

/// Offsets of the matching frames among the selected ones; `query` arrives stripped of whitespace.
pub fn search_frames(
    capture_id: &str,
    query: &str,
    search_id: bool,
    search_data: bool,
    selection: &FrameSelection,
) -> Result<Vec<usize>, String> {
    with("search frames", |c| {
        wiretap_capture::search_frames(c, capture_id, query, search_id, search_data, selection)
    })
}

pub fn get_all_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    with("read frames", |c| {
        wiretap_capture::get_all_frames(c, capture_id)
    })
    .map(messages)
}

pub fn get_latest_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    with("read frames", |c| {
        wiretap_capture::get_latest_frames(c, capture_id)
    })
    .map(messages)
}

pub fn read_frame_chunk(
    capture_id: &str,
    after_rowid: i64,
    limit: usize,
) -> Result<Vec<(i64, FrameMessage)>, String> {
    with("read frames", |c| {
        wiretap_capture::read_frame_chunk(c, capture_id, after_rowid, limit)
    })
    .map(messages_with_rowids)
}

pub fn read_frame_chunk_reverse(
    capture_id: &str,
    before_rowid: i64,
    limit: usize,
) -> Result<Vec<(i64, FrameMessage)>, String> {
    with("read frames", |c| {
        wiretap_capture::read_frame_chunk_reverse(c, capture_id, before_rowid, limit)
    })
    .map(messages_with_rowids)
}

pub fn get_rowid_range(capture_id: &str) -> Result<Option<(i64, i64)>, String> {
    with("read frames", |c| {
        wiretap_capture::get_rowid_range(c, capture_id)
    })
}

pub fn find_rowid_for_timestamp(
    capture_id: &str,
    timestamp_us: u64,
) -> Result<Option<i64>, String> {
    with("find a frame by time", |c| {
        wiretap_capture::find_rowid_for_timestamp(c, capture_id, timestamp_us)
    })
}

pub fn get_frame_at_index(
    capture_id: &str,
    index: usize,
) -> Result<Option<(i64, FrameMessage)>, String> {
    with("read frames", |c| {
        wiretap_capture::get_frame_at_index(c, capture_id, index)
    })
    .map(|row| row.map(|(rowid, f)| (rowid, f.into())))
}

/// Returns (rowid, frame_index, frame).
pub fn get_next_filtered_frame(
    capture_id: &str,
    current_rowid: i64,
    selection: &FrameSelection,
    backward: bool,
) -> Result<Option<(i64, usize, FrameMessage)>, String> {
    with("read frames", |c| {
        wiretap_capture::get_next_filtered_frame(c, capture_id, current_rowid, selection, backward)
    })
    .map(|row| row.map(|(rowid, index, f)| (rowid, index, f.into())))
}

pub fn count_frames_before_rowid(capture_id: &str, rowid: i64) -> Result<usize, String> {
    with("count frames", |c| {
        wiretap_capture::count_frames_before_rowid(c, capture_id, rowid)
    })
}

// ============================================================================
// Byte reads
// ============================================================================

/// Returns (bytes, total_count).
pub fn get_bytes_paginated(
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<TimestampedByte>, usize), String> {
    with("read bytes", |c| {
        wiretap_capture::get_bytes_paginated(c, capture_id, offset, limit)
    })
}

/// The last `limit` bytes, oldest first; the caller has the total.
pub fn get_bytes_tail_rows(capture_id: &str, limit: usize) -> Result<Vec<TimestampedByte>, String> {
    with("read bytes", |c| {
        wiretap_capture::get_bytes_tail_rows(c, capture_id, limit)
    })
}

pub fn get_all_bytes(capture_id: &str) -> Result<Vec<TimestampedByte>, String> {
    with("read bytes", |c| {
        wiretap_capture::get_all_bytes(c, capture_id)
    })
}

pub fn find_bytes_offset_for_timestamp(capture_id: &str, target_us: u64) -> Result<usize, String> {
    with("find a byte by time", |c| {
        wiretap_capture::find_bytes_offset_for_timestamp(c, capture_id, target_us)
    })
}

/// Run a read-only `statement`, one `T` per row. Setting `cancel` aborts it
/// between SQLite VM steps.
pub fn read_rows<T>(
    statement: &Sql,
    cancel: &Arc<AtomicBool>,
    map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    with("run the query", |c| {
        wiretap_capture::read_rows(c, statement, cancel, map)
    })
}

// ============================================================================
// Capture metadata
// ============================================================================

pub fn save_capture_metadata(meta: &CaptureMetadata) -> Result<(), String> {
    with("save capture metadata", |c| {
        wiretap_capture::save_capture_metadata(c, meta)
    })
}

pub fn load_all_capture_metadata() -> Result<Vec<CaptureMetadata>, String> {
    with("load capture metadata", |c| {
        wiretap_capture::load_all_capture_metadata(c)
    })
}

pub fn update_capture_name(capture_id: &str, new_name: &str) -> Result<(), String> {
    with("update capture name", |c| {
        wiretap_capture::update_capture_name(c, capture_id, new_name)
    })
}

pub fn update_capture_persistent(capture_id: &str, persistent: bool) -> Result<(), String> {
    with("update capture persistent flag", |c| {
        wiretap_capture::update_capture_persistent(c, capture_id, persistent)
    })
}

/// Backfills the buses of a capture stored before they were tracked.
pub fn get_distinct_buses(capture_id: &str, kind: CaptureKind) -> Result<Vec<u8>, String> {
    with("read capture buses", |c| {
        wiretap_capture::get_distinct_buses(c, capture_id, kind)
    })
}

pub fn delete_capture_metadata(capture_id: &str) -> Result<(), String> {
    with("delete capture metadata", |c| {
        wiretap_capture::delete_capture_metadata(c, capture_id)
    })
}

// ============================================================================
// Capture events
// ============================================================================

fn parse_event_id(id: &str) -> Result<i64, String> {
    id.parse().map_err(|_| format!("Invalid event id '{id}'"))
}

fn new_event(timestamp_us: i64, duration_us: i64, note: &str) -> NewEvent {
    NewEvent {
        ts_us: timestamp_us,
        duration_us,
        note: note.into(),
    }
}

pub fn list_capture_events(capture_id: &str) -> Result<Vec<CaptureEvent>, String> {
    with("read events", |c| {
        wiretap_capture::list_capture_events(c, capture_id)
    })
    .map(|events| events.into_iter().map(CaptureEvent::from).collect())
}

pub fn insert_capture_event(
    capture_id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let event = new_event(timestamp_us, duration_us, note);
    with("insert event", |c| {
        wiretap_capture::insert_capture_event(c, capture_id, &event)
    })
    .map(CaptureEvent::from)
}

pub fn update_capture_event(
    capture_id: &str,
    id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let (id, event) = (
        parse_event_id(id)?,
        new_event(timestamp_us, duration_us, note),
    );
    with("update event", |c| {
        wiretap_capture::update_capture_event(c, capture_id, id, &event)
    })
    .map(CaptureEvent::from)
}

pub fn delete_capture_event(capture_id: &str, id: &str) -> Result<(), String> {
    let id = parse_event_id(id)?;
    with("delete event", |c| {
        wiretap_capture::delete_capture_event(c, capture_id, id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_message_round_trips_through_the_store() {
        let _db = use_own_database();
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
                protocol: wiretap_protocol::ingest::MODBUS_RTU_PROTOCOL.into(),
                crc_valid: Some(false),
                ..can(0x0103, 4, vec![1, 3, 0xAA, 0xBB], None)
            },
        ];
        insert_frames("c1", &frames).unwrap();

        let json = |frames: &[FrameMessage]| serde_json::to_value(frames).unwrap();
        assert_eq!(json(&get_all_frames("c1").unwrap()), json(&frames));
    }

    #[test]
    fn a_store_error_says_what_failed_and_its_own_messages_stand_alone() {
        let _db = use_own_connection(Connection::open_in_memory().unwrap());
        assert!(get_frame_count("c1")
            .unwrap_err()
            .starts_with("Failed to count frames: no such table: frames"));
        let _db = use_own_database();
        assert_eq!(
            delete_capture_event("c1", "7"),
            Err("Event not found".into())
        );
        assert_eq!(
            delete_capture_event("c1", "x"),
            Err("Invalid event id 'x'".into())
        );
    }

    /// Opens only a copy: never a file named like the app's database, nor anything under
    /// the data directory every app identifier's database lives in.
    /// `WIRETAP_CAPTURE_DB_COPY=<copy> cargo test -p wiretap --lib a_copied_capture_db -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_copied_capture_db_migrates_and_reads_unchanged() {
        let path =
            std::env::var("WIRETAP_CAPTURE_DB_COPY").expect("WIRETAP_CAPTURE_DB_COPY names a copy");
        let path = std::fs::canonicalize(path).expect("the copy exists");
        let data = dirs::data_dir()
            .and_then(|d| std::fs::canonicalize(d).ok())
            .expect("a data directory");
        assert!(
            !path.starts_with(&data),
            "refusing {path:?}: it is under {data:?}, where the app's databases live"
        );
        assert_ne!(
            path.file_name(),
            Some("buffers.db".as_ref()),
            "refusing {path:?}: copy it to another name"
        );

        let mut conn = Connection::open(&path).unwrap();
        let before: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let applied = wiretap_capture::migrate(&mut conn).unwrap();
        println!(
            "version {before}, applied {:?}",
            applied.iter().map(|m| m.version).collect::<Vec<_>>()
        );
        if before == wiretap_capture::SCHEMA_VERSION {
            assert!(
                applied.is_empty(),
                "a database at the current version applies nothing"
            );
        }
        let captures = wiretap_capture::load_all_capture_metadata(&conn).unwrap();
        println!("captures: {}", captures.len());
        for meta in &captures {
            match meta.kind {
                CaptureKind::Frames => {
                    let inventory =
                        wiretap_capture::frame_inventory(&conn, &meta.id, None, None).unwrap();
                    let (page, _) =
                        wiretap_capture::get_frames_paginated(&conn, &meta.id, 0, 50).unwrap();
                    let count = wiretap_capture::get_frame_count(&conn, &meta.id).unwrap();
                    println!(
                        "frames: {count} rows, {} identities, first page {}",
                        inventory.len(),
                        page.len()
                    );
                }
                CaptureKind::Bytes => {
                    let (page, count) =
                        wiretap_capture::get_bytes_paginated(&conn, &meta.id, 0, 50).unwrap();
                    println!("bytes: {count} rows, first page {}", page.len());
                }
            }
        }
        assert!(
            wiretap_capture::migrate(&mut conn).unwrap().is_empty(),
            "a second migrate applies nothing"
        );
    }
}

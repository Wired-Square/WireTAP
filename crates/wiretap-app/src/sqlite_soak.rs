//! Soak tests for the capture store: real files, load, cancel, crash. Every test is
//! ignored and needs the `sqlite3` CLI; run one per process, e.g.
//! `cargo test -p wiretap --lib sqlite_soak::concurrent_soak -- --ignored --exact --nocapture`.
//! The real-file tests copy `pristine-buffers.db` and `transmit_history-copy.db` (with
//! their sidecars) from the directory `WIRETAP_SOAK_DIR` names, never opening the originals.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use wiretap_analysis::source::FrameSelection;
use wiretap_capture_store::{Cancel, CaptureError, Sql, Store};

use crate::capture_db::{self, wait};
use crate::capture_store::{self, CaptureKind, CaptureMetadata};
use crate::io::FrameMessage;

fn real_file(name: &str) -> PathBuf {
    let dir = std::env::var_os("WIRETAP_SOAK_DIR").expect("WIRETAP_SOAK_DIR names the directory of real files");
    Path::new(&dir).join(name)
}

fn pristine() -> PathBuf {
    real_file("pristine-buffers.db")
}

fn fresh_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join("wiretap-soak").join(format!("{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_writable(from: &Path, to: &Path) {
    std::fs::copy(from, to).unwrap();
    std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o644)).unwrap();
}

fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(suffix);
    s.into()
}

fn file_len(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

fn file_mode(p: &Path) -> Option<String> {
    std::fs::metadata(p).ok().map(|m| format!("{:o}", m.permissions().mode() & 0o777))
}

struct Rng(u64);

impl Rng {
    fn seeded() -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
        Self(nanos | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: u64, hi_inclusive: u64) -> u64 {
        lo + self.next() % (hi_inclusive - lo + 1)
    }
}

fn sqlite3(db: &Path, sql: &str) -> String {
    let out = Command::new("sqlite3").args(["-batch", "-noheader", "-separator", "|"]).arg(db).arg(sql).output().unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success() && stderr.is_empty(), "sqlite3 {sql}: {stderr}");
    String::from_utf8(out.stdout).unwrap().trim_end().to_string()
}

/// sqlite3's stdout and stderr, without asserting success.
fn sqlite3_raw(db: &Path, sql: &str) -> (String, String) {
    let out = Command::new("sqlite3").args(["-batch", "-noheader", "-separator", "|"]).arg(db).arg(sql).output().unwrap();
    (String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

const FRAME_COLS: &[&str] = &[
    "rowid", "capture_id", "protocol", "timestamp_us", "frame_id", "bus", "dlc", "payload", "is_extended", "is_fd",
    "source_address", "incomplete", "direction", "is_rtr", "is_brs", "is_esi",
];

/// The tables and columns of the pre-upgrade file, with a row filter.
const ORIGINAL: &[(&str, &[&str], &str)] = &[
    ("frames", FRAME_COLS, ""),
    ("bytes", &["rowid", "capture_id", "byte_val", "timestamp_us", "bus"], ""),
    (
        "capture_metadata",
        &[
            "rowid", "capture_id", "capture_kind", "name", "count", "start_time_us", "end_time_us", "created_at",
            "owning_session_id", "persistent", "buses",
        ],
        "",
    ),
    (
        "capture_events",
        &["id", "capture_id", "timestamp_us", "duration_us", "note", "created_at_us", "updated_at_us"],
        "",
    ),
    ("schema_migrations", &["version", "name", "applied_at"], "WHERE version <= 5"),
];

fn quoted_select(table: &str, cols: &[&str], filter: &str) -> String {
    let cols: Vec<String> = cols.iter().map(|c| format!("quote({c})")).collect();
    format!("SELECT {} FROM {table} {filter} ORDER BY rowid", cols.join(", "))
}

fn table_digest(db: &Path, table: &str, cols: &[&str], filter: &str) -> (i64, String) {
    let sql = quoted_select(table, cols, filter);
    let out = Command::new("sh")
        .arg("-c")
        .arg(r#"set -o pipefail; sqlite3 -batch -noheader -separator '|' "$1" "$2" | shasum -a 256"#)
        .arg("sh")
        .arg(db)
        .arg(&sql)
        .output()
        .unwrap();
    assert!(out.status.success(), "digest {table}: {}", String::from_utf8_lossy(&out.stderr));
    let hash = String::from_utf8(out.stdout).unwrap().split_whitespace().next().unwrap().to_string();
    let count = sqlite3(db, &format!("SELECT COUNT(*) FROM {table} {filter}")).parse().unwrap();
    (count, hash)
}

type Digests = Vec<(String, i64, String)>;

fn digests(db: &Path) -> Digests {
    ORIGINAL
        .iter()
        .map(|(table, cols, filter)| {
            let (count, hash) = table_digest(db, table, cols, filter);
            (table.to_string(), count, hash)
        })
        .collect()
}

fn print_digests(label: &str, d: &Digests) {
    for (t, n, h) in d {
        println!("  {label} {t:<18} rows {n:>8}  sha256 {}", &h[..16]);
    }
}

fn quote_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn opt_int(v: Option<i64>) -> String {
    v.map_or_else(|| "NULL".into(), |v| v.to_string())
}

/// A frame as sqlite3 prints `quote()` of every original column.
fn quoted_line(rowid: i64, capture_id: &str, f: &FrameMessage) -> String {
    format!(
        "{rowid}|{}|{}|{}|{}|{}|{}|X'{}'|{}|{}|{}|{}|{}|{}|{}|{}",
        quote_text(capture_id),
        quote_text(&f.protocol),
        f.timestamp_us,
        f.frame_id,
        f.bus,
        f.dlc,
        hex::encode_upper(&f.bytes),
        f.is_extended as u8,
        f.is_fd as u8,
        opt_int(f.source_address.map(i64::from)),
        opt_int(f.incomplete.map(i64::from)),
        f.direction.as_deref().map_or_else(|| "NULL".into(), quote_text),
        f.is_rtr as u8,
        f.is_brs as u8,
        f.is_esi as u8,
    )
}

fn soak_frame(seq: u64) -> FrameMessage {
    let fd = seq.is_multiple_of(5);
    let extended = seq.is_multiple_of(7);
    let len: u64 = if fd { 64 } else { 8 };
    FrameMessage {
        protocol: "can".into(),
        timestamp_us: seq,
        frame_id: if extended { 0x18FF_0000 | (seq % 256) as u32 } else { 0x100 + (seq % 16) as u32 },
        bus: (seq % 2) as u8,
        dlc: len as u16,
        bytes: (0..len).map(|i| seq.wrapping_mul(31).wrapping_add(i) as u8).collect(),
        is_extended: extended,
        is_fd: fd,
        is_brs: fd,
        direction: Some("rx".into()),
        ..Default::default()
    }
}

fn batch(from: u64, n: u64) -> Vec<FrameMessage> {
    (from..from + n).map(soak_frame).collect()
}

fn json(f: &FrameMessage) -> serde_json::Value {
    serde_json::to_value(f).unwrap()
}

fn current_thread() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn multi_thread(workers: usize) -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(workers).enable_all().build().unwrap()
}

async fn scalar_i64(store: &Store, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(store.database().pool()).await.unwrap()
}

async fn integrity(store: &Store) -> String {
    let rows: Vec<String> =
        sqlx::query_scalar("PRAGMA integrity_check").fetch_all(store.database().pool()).await.unwrap();
    rows.join(";")
}

struct Watchdog(Arc<AtomicBool>);

/// Aborts the process if not dropped within `limit`: a hang ends the run with a message.
fn watchdog(label: &'static str, limit: Duration) -> Watchdog {
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < limit {
            if flag.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("WATCHDOG: {label} still running after {limit:?}: HANG, aborting");
        std::process::abort();
    });
    Watchdog(done)
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

// ============================================================================
// 1 + 2: real-file fidelity, reopen and idempotence
// ============================================================================

#[test]
#[ignore]
fn real_file_fidelity_and_reopen() {
    let dir = fresh_dir("fidelity");
    let a = dir.join("A.db");
    copy_writable(&pristine(), &a);
    let started = Instant::now();
    let before = digests(&a);
    println!("[1] digests of the copy before the app opened it ({:?}):", started.elapsed());
    print_digests("before", &before);
    let schema_before = sqlite3(&a, ".schema");
    println!(
        "[1] before: user_version {}, journal_mode {}",
        sqlite3(&a, "PRAGMA user_version"),
        sqlite3(&a, "PRAGMA journal_mode")
    );

    let rt = current_thread();
    let (applied, open_time) = rt.block_on(async {
        let t = Instant::now();
        let (store, applied) = Store::open(&a).await.unwrap();
        let open_time = t.elapsed();
        store.close().await;
        (applied, open_time)
    });
    println!("[1] Store::open took {open_time:?}, applied legacy {:?}", applied.iter().map(|m| (m.version, m.name)).collect::<Vec<_>>());
    println!(
        "[1] after close: db {:?} bytes mode {:?}; -wal {:?} bytes mode {:?}; -shm {:?} bytes mode {:?}",
        file_len(&a),
        file_mode(&a),
        file_len(&sidecar(&a, "-wal")),
        file_mode(&sidecar(&a, "-wal")),
        file_len(&sidecar(&a, "-shm")),
        file_mode(&sidecar(&a, "-shm"))
    );

    let after = digests(&a);
    print_digests("after ", &after);
    assert_eq!(before, after, "original columns changed across the upgrade");
    println!("[1] digests equal: YES");

    let schema_after = sqlite3(&a, ".schema");
    let before_lines: Vec<&str> = schema_before.lines().collect();
    for line in schema_after.lines().filter(|l| !before_lines.contains(l)) {
        println!("[1] schema line added/changed: {line}");
    }
    for line in before_lines.iter().filter(|l| !schema_after.lines().any(|a| a == **l)) {
        println!("[1] schema line removed/changed: {line}");
    }
    println!("[1] frames.crc_valid: {}", sqlite3(&a, "SELECT name, type, \"notnull\", quote(dflt_value) FROM pragma_table_info('frames') WHERE name = 'crc_valid'"));
    let crc_set = sqlite3(&a, "SELECT COUNT(*) FROM frames WHERE crc_valid IS NOT NULL");
    assert_eq!(crc_set, "0");
    println!("[1] rows with crc_valid set: {crc_set}");
    println!("[1] integrity_check: {}", sqlite3(&a, "PRAGMA integrity_check"));
    println!("[1] foreign_key_check: {:?}", sqlite3(&a, "PRAGMA foreign_key_check"));
    println!("[1] journal_mode: {}", sqlite3(&a, "PRAGMA journal_mode"));
    println!("[1] user_version: {}", sqlite3(&a, "PRAGMA user_version"));
    println!("[1] tables: {}", sqlite3(&a, "SELECT group_concat(name, ', ') FROM sqlite_master WHERE type = 'table'"));
    println!("[1] schema_migrations: {}", sqlite3(&a, "SELECT group_concat(version || ':' || name, ', ') FROM schema_migrations"));
    let chain_rows = |db: &Path| sqlite3(db, "SELECT version, description, checksum, installed_on FROM _capture_migrations ORDER BY version");
    let registry_rows = |db: &Path| sqlite3(db, "SELECT * FROM _migration_chains");
    let (chain1, reg1) = (chain_rows(&a), registry_rows(&a));
    println!("[1] _capture_migrations: {chain1}");
    println!("[1] _migration_chains: {reg1}");
    assert_eq!(sqlite3(&a, "PRAGMA integrity_check"), "ok");
    assert_eq!(sqlite3(&a, "PRAGMA user_version"), "6");
    assert_eq!(sqlite3(&a, "PRAGMA journal_mode"), "wal");

    // 2: a second open applies nothing and changes nothing.
    let store = rt.block_on(async {
        let t = Instant::now();
        let (store, applied) = Store::open(&a).await.unwrap();
        println!("[2] second open took {:?}, applied legacy {:?}", t.elapsed(), applied.len());
        assert!(applied.is_empty());
        store
    });
    let _own = capture_db::use_own_store(store.clone());

    // 1, continued: every frame through the app's own paginated reader against sqlite3.
    let metas = rt.block_on(capture_db::load_all_capture_metadata()).unwrap();
    let meta_cli = sqlite3(&a, "SELECT capture_id, capture_kind, name, count, quote(start_time_us), quote(end_time_us), created_at, quote(owning_session_id), persistent, buses FROM capture_metadata ORDER BY capture_id");
    let mut metas_sorted = metas.clone();
    metas_sorted.sort_by(|x, y| x.id.cmp(&y.id));
    let meta_api: Vec<String> = metas_sorted
        .iter()
        .map(|m| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                m.id,
                match m.kind {
                    CaptureKind::Frames => "frames",
                    CaptureKind::Bytes => "bytes",
                },
                m.name,
                m.count,
                opt_int(m.start_time_us.map(|v| v as i64)),
                opt_int(m.end_time_us.map(|v| v as i64)),
                m.created_at,
                m.owning_session_id.as_deref().map_or_else(|| "NULL".into(), quote_text),
                m.persistent as u8,
                serde_json::to_string(&m.buses).unwrap()
            )
        })
        .collect();
    println!("[1] metadata via sqlite3:\n{meta_cli}");
    println!("[1] metadata via app:\n{}", meta_api.join("\n"));
    assert_eq!(meta_cli, meta_api.join("\n"), "metadata differs");

    for meta in &metas {
        match meta.kind {
            CaptureKind::Frames => {
                let cli_file = dir.join(format!("{}.frames.txt", meta.id));
                let sql = quoted_select("frames", FRAME_COLS, &format!("WHERE capture_id = '{}'", meta.id));
                let status = Command::new("sqlite3")
                    .args(["-batch", "-noheader", "-separator", "|"])
                    .arg(&a)
                    .arg(&sql)
                    .stdout(std::fs::File::create(&cli_file).unwrap())
                    .status()
                    .unwrap();
                assert!(status.success());
                let cli = std::fs::read_to_string(&cli_file).unwrap();
                let mut cli_lines = cli.lines();
                let t = Instant::now();
                let (mut offset, mut compared, mut pages) = (0usize, 0usize, 0usize);
                let samples_sql = format!(
                    "SELECT rowid FROM frames WHERE capture_id = '{0}' ORDER BY timestamp_us DESC LIMIT 1;
                     SELECT rowid FROM frames WHERE capture_id = '{0}' AND is_extended = 1 LIMIT 1;
                     SELECT rowid FROM frames WHERE capture_id = '{0}' ORDER BY frame_id DESC LIMIT 1;
                     SELECT max(rowid) FROM frames WHERE capture_id = '{0}';
                     SELECT min(rowid) FROM frames WHERE capture_id = '{0}';",
                    meta.id
                );
                let sample_rowids: Vec<i64> = sqlite3(&a, &samples_sql).lines().map(|l| l.parse().unwrap()).collect();
                let mut samples = HashMap::new();
                loop {
                    let (frames, rowids) = rt.block_on(capture_db::get_frames_paginated(&meta.id, offset, 10_000)).unwrap();
                    if frames.is_empty() {
                        break;
                    }
                    pages += 1;
                    for (f, rowid) in frames.iter().zip(&rowids) {
                        let line = quoted_line(*rowid, &meta.id, f);
                        let expected = cli_lines.next().expect("the app returned more rows than sqlite3");
                        assert_eq!(line, expected, "row {rowid} differs");
                        if sample_rowids.contains(rowid) {
                            samples.insert(*rowid, line);
                        }
                        compared += 1;
                    }
                    offset += frames.len();
                }
                assert!(cli_lines.next().is_none(), "sqlite3 has rows the app did not return");
                assert_eq!(compared, meta.count);
                println!(
                    "[1] capture {} frames: {compared} rows read through capture_db::get_frames_paginated in {pages} pages ({:?}), every row byte-identical to sqlite3 quote() output",
                    meta.id,
                    t.elapsed()
                );
                for (label, rowid) in ["largest timestamp", "first extended id", "largest frame id", "last rowid", "first rowid"].iter().zip(&sample_rowids) {
                    println!("[1]   {label} (rowid {rowid}): {}", samples[rowid]);
                }
                let _ = std::fs::remove_file(&cli_file);
            }
            CaptureKind::Bytes => {
                let cli = sqlite3(&a, &format!("SELECT byte_val, timestamp_us, bus FROM bytes WHERE capture_id = '{}' ORDER BY rowid", meta.id));
                let bytes = rt.block_on(capture_db::get_all_bytes(&meta.id)).unwrap();
                let api: Vec<String> = bytes.iter().map(|b| format!("{}|{}|{}", b.byte, b.timestamp_us, b.bus)).collect();
                assert_eq!(cli, api.join("\n"), "bytes of {} differ", meta.id);
                println!("[1] capture {} bytes: {} rows identical to sqlite3", meta.id, api.len());
            }
        }
    }

    // FD 64-byte, extended, flags and the largest timestamp a column holds: the file has none.
    let probe = vec![
        FrameMessage { timestamp_us: i64::MAX as u64, ..soak_frame(5) },
        FrameMessage { is_esi: true, is_rtr: false, source_address: Some(0xFFFF), incomplete: Some(false), crc_valid: Some(true), direction: Some("tx".into()), ..soak_frame(35) },
        FrameMessage { frame_id: 0x1FFF_FFFF, is_extended: true, ..soak_frame(10) },
    ];
    rt.block_on(capture_db::insert_frames("fd_probe", &probe)).unwrap();
    let back = rt.block_on(capture_db::get_all_frames("fd_probe")).unwrap();
    assert_eq!(back.iter().map(json).collect::<Vec<_>>(), probe.iter().map(json).collect::<Vec<_>>());
    let cli = sqlite3(&a, &quoted_select("frames", FRAME_COLS, "WHERE capture_id = 'fd_probe'"));
    let (_, rowids) = rt.block_on(capture_db::get_frames_paginated("fd_probe", 0, 10)).unwrap();
    let api: Vec<String> = back.iter().zip(&rowids).map(|(f, r)| quoted_line(*r, "fd_probe", f)).collect();
    assert_eq!(cli, api.join("\n"));
    println!("[1] synthetic FD/extended/i64::MAX probe: round trip identical through the app and sqlite3:\n{cli}");
    rt.block_on(capture_db::delete_capture_data("fd_probe")).unwrap();

    drop(_own);
    rt.block_on(store.close());
    println!("[2] after second close: -wal {:?}, -shm {:?}", file_len(&sidecar(&a, "-wal")), file_len(&sidecar(&a, "-shm")));
    let again = digests(&a);
    assert_eq!(before, again);
    assert_eq!(chain1, chain_rows(&a));
    assert_eq!(reg1, registry_rows(&a));
    println!("[2] digests and migration tables unchanged after the second open: YES");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Copies of the real files opened as the app starts: every capture listed with the count
/// its rows hold, and each file intact.
#[test]
#[ignore]
fn real_files_through_the_app() {
    let dir = fresh_dir("app-path");
    copy_writable(&pristine(), &dir.join("buffers.db"));
    for suffix in ["", "-wal", "-shm"] {
        copy_writable(&sidecar(&real_file("transmit_history-copy.db"), suffix), &sidecar(&dir.join("transmit_history.db"), suffix));
    }
    let rows_of = |kind: &str| -> HashMap<String, usize> {
        let table = if kind == "frames" { "frames" } else { "bytes" };
        sqlite3(&dir.join("buffers.db"), &format!("SELECT m.capture_id, (SELECT COUNT(*) FROM {table} WHERE capture_id = m.capture_id) FROM capture_metadata m WHERE m.capture_kind = '{kind}'"))
            .lines()
            .map(|l| l.split_once('|').map(|(id, n)| (id.to_string(), n.parse().unwrap())).unwrap())
            .collect()
    };
    let (frames, bytes) = (rows_of("frames"), rows_of("bytes"));
    let transmit_rows = sqlite3(&dir.join("transmit_history.db"), "SELECT COUNT(*) FROM transmit_history");

    capture_db::initialise(&dir, false).unwrap();
    capture_store::hydrate_from_db();
    crate::transmit_history::initialise(&dir).unwrap();

    let listed = capture_store::list_captures();
    for meta in &listed {
        println!("[app] {} {:?} '{}': {} rows, persistent {}", meta.id, meta.kind, meta.name, meta.count, meta.persistent);
        let expected = match meta.kind {
            CaptureKind::Frames => frames[&meta.id],
            CaptureKind::Bytes => bytes[&meta.id],
        };
        assert_eq!(meta.count, expected, "{}", meta.id);
    }
    assert_eq!(listed.len(), frames.len() + bytes.len());
    let total = |kind| listed.iter().filter(|m| m.kind == kind).map(|m| m.count).sum::<usize>();
    println!("[app] {} captures, {} frames, {} bytes", listed.len(), total(CaptureKind::Frames), total(CaptureKind::Bytes));
    let store = capture_db::current();
    let capture_integrity = wait(integrity(&store));
    println!("[app] buffers.db integrity_check: {capture_integrity}");
    assert_eq!(capture_integrity, "ok");

    let transmit = dir.join("transmit_history.db");
    println!(
        "[app] transmit_history.db: {} rows (copy had {transmit_rows}), integrity_check {}",
        sqlite3(&transmit, "SELECT COUNT(*) FROM transmit_history"),
        sqlite3(&transmit, "PRAGMA integrity_check")
    );
    assert_eq!(sqlite3(&transmit, "SELECT COUNT(*) FROM transmit_history"), transmit_rows);
    assert_eq!(sqlite3(&transmit, "PRAGMA integrity_check"), "ok");
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 3: concurrent soak
// ============================================================================

#[derive(Default)]
struct Tally {
    errors: Mutex<Vec<String>>,
    ops: Mutex<HashMap<&'static str, usize>>,
    max_wait_us: Mutex<HashMap<&'static str, u64>>,
}

impl Tally {
    fn error(&self, what: String) {
        eprintln!("SOAK ERROR: {what}");
        self.errors.lock().unwrap().push(what);
    }
    fn op(&self, actor: &'static str, took: Duration) {
        *self.ops.lock().unwrap().entry(actor).or_default() += 1;
        let us = took.as_micros() as u64;
        let mut m = self.max_wait_us.lock().unwrap();
        let e = m.entry(actor).or_default();
        *e = (*e).max(us);
    }
}

fn lifecycle_round(tag: &str, n: usize, tally: &Tally, actor: &'static str) {
    let t = Instant::now();
    let id = format!("lc_{tag}_{n}");
    let meta = CaptureMetadata {
        id: id.clone(),
        kind: CaptureKind::Frames,
        name: "lifecycle".into(),
        count: 0,
        start_time_us: None,
        end_time_us: None,
        created_at: 1,
        is_streaming: false,
        owning_session_id: None,
        persistent: false,
        buses: vec![],
    };
    let steps: [(&str, Result<(), String>); 6] = [
        ("save", wait(capture_db::save_capture_metadata(&meta))),
        ("rename", wait(capture_db::update_capture_name(&id, "renamed"))),
        ("persist", wait(capture_db::update_capture_persistent(&id, true))),
        ("insert", wait(capture_db::insert_frames(&id, &batch(0, 10)))),
        ("delete data", wait(capture_db::delete_capture_data(&id))),
        ("delete meta", wait(capture_db::delete_capture_metadata(&id))),
    ];
    for (step, r) in steps {
        if let Err(e) = r {
            tally.error(format!("{actor} {step} {id}: {e}"));
        }
    }
    // The registry's own sync wrappers, which log rather than return their errors.
    let reg = capture_store::create_standalone_capture(CaptureKind::Frames, format!("lc {tag} {n}"));
    let _ = capture_store::rename_capture(&reg, "renamed");
    let _ = capture_store::set_capture_persistent(&reg, true);
    let _ = capture_store::delete_capture(&reg);
    tally.op(actor, t.elapsed());
}

fn check_frames(frames: &[FrameMessage], rowids: &[i64], tally: &Tally, actor: &str) {
    for w in rowids.windows(2) {
        if w[0] >= w[1] {
            tally.error(format!("{actor}: rowids out of order {w:?}"));
            return;
        }
    }
    for w in frames.windows(2) {
        if w[0].timestamp_us + 1 != w[1].timestamp_us {
            tally.error(format!("{actor}: timestamps not consecutive {} -> {}", w[0].timestamp_us, w[1].timestamp_us));
            return;
        }
    }
    for f in frames {
        if json(f) != json(&soak_frame(f.timestamp_us)) {
            tally.error(format!("{actor}: frame {} payload/flags differ", f.timestamp_us));
            return;
        }
    }
}

#[test]
#[ignore]
fn concurrent_soak() {
    let secs: u64 = std::env::var("SOAK_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
    let _dog = watchdog("concurrent_soak", Duration::from_secs(secs + 240));
    let dir = fresh_dir("soak");
    let db = dir.join("buffers.db");
    capture_db::initialise(&dir, false).unwrap();
    let store = capture_db::current();

    let x = capture_store::create_session_capture("soak_session", CaptureKind::Frames, "soak X".into());
    let y = "soak_y".to_string();
    let tally = Arc::new(Tally::default());
    let stop = Arc::new(AtomicBool::new(false));
    let written_x = Arc::new(AtomicU64::new(0));
    let written_y = Arc::new(AtomicU64::new(0));
    let cancels = Arc::new(AtomicUsize::new(0));
    let completed_queries = Arc::new(AtomicUsize::new(0));
    let max_wal = Arc::new(AtomicU64::new(0));

    let wal_monitor = {
        let (stop, max_wal, wal) = (stop.clone(), max_wal.clone(), sidecar(&db, "-wal"));
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                max_wal.fetch_max(file_len(&wal).unwrap_or(0), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let std_lifecycle = {
        let (stop, tally) = (stop.clone(), tally.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            while !stop.load(Ordering::Relaxed) {
                lifecycle_round("std", n, &tally, "lifecycle std::thread");
                n += 1;
                std::thread::sleep(Duration::from_millis(15));
            }
        })
    };

    let rt = multi_thread(4);
    let started = Instant::now();
    rt.block_on(async {
        let mut handles = Vec::new();
        // The merge task's path: append_frames_to_session -> append_frames_to_capture.
        handles.push({
            let (stop, tally, written) = (stop.clone(), tally.clone(), written_x.clone());
            tokio::spawn(async move {
                let mut rng = Rng::seeded();
                let mut seq = 0;
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    capture_store::append_frames_to_session("soak_session", batch(seq, 100)).await;
                    tally.op("writer X (merge path)", t.elapsed());
                    seq += 100;
                    written.store(seq, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(rng.range(5, 10))).await;
                }
            })
        });
        // The same inserts with their errors visible.
        handles.push({
            let (stop, tally, written, y) = (stop.clone(), tally.clone(), written_y.clone(), y.clone());
            tokio::spawn(async move {
                let mut rng = Rng::seeded();
                let mut seq = 0;
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    match capture_db::insert_frames(&y, &batch(seq, 100)).await {
                        Ok(()) => {
                            seq += 100;
                            written.store(seq, Ordering::Relaxed);
                        }
                        Err(e) => tally.error(format!("writer Y insert at {seq}: {e}")),
                    }
                    tally.op("writer Y (insert_frames)", t.elapsed());
                    tokio::time::sleep(Duration::from_millis(rng.range(5, 10))).await;
                }
            })
        });
        for reader in ["tail reader 1", "tail reader 2"] {
            let (stop, tally, x) = (stop.clone(), tally.clone(), x.clone());
            handles.push(tokio::spawn(async move {
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    match capture_store::get_capture_frames_tail(&x, 200, &FrameSelection::default()).await {
                        Ok(tail) => {
                            let rowids: Vec<i64> = tail.capture_indices.iter().map(|&r| r as i64).collect();
                            check_frames(&tail.frames, &rowids, &tally, reader);
                        }
                        Err(e) => tally.error(format!("{reader}: {e}")),
                    }
                    tally.op(reader, t.elapsed());
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }));
        }
        // A cancellable query, cancelled at a random moment.
        handles.push({
            let (stop, tally, x, cancels, completed) = (stop.clone(), tally.clone(), x.clone(), cancels.clone(), completed_queries.clone());
            tokio::spawn(async move {
                let mut rng = Rng::seeded();
                while !stop.load(Ordering::Relaxed) {
                    let cancel = Cancel::new();
                    let after = rng.range(0, 300);
                    let setter = {
                        let cancel = cancel.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(after)).await;
                            cancel.cancel();
                        })
                    };
                    let spec = wslib_wiretap_gateway::QuerySpec::FrameChanges {
                        frame_id: 0x101,
                        is_extended: None,
                        window: wslib_wiretap_gateway::RowWindow::default(),
                        limit: None,
                    };
                    let t = Instant::now();
                    match crate::query::capture::run(&x, &spec, None, &cancel).await {
                        Ok(_) => {
                            completed.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(e) if e == "Query cancelled" => {
                            cancels.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(e) => tally.error(format!("query::run: {e}")),
                    }
                    tally.op("query::capture::run", t.elapsed());
                    setter.abort();
                }
            })
        });
        // A long paginated scan, dropped at a random moment.
        handles.push({
            let (stop, tally, x) = (stop.clone(), tally.clone(), x.clone());
            tokio::spawn(async move {
                let mut rng = Rng::seeded();
                while !stop.load(Ordering::Relaxed) {
                    let budget = Duration::from_millis(rng.range(1, 400));
                    let scan = async {
                        let mut offset = 0;
                        loop {
                            match capture_db::get_frames_paginated(&x, offset, 5_000).await {
                                Ok((frames, rowids)) if !frames.is_empty() => {
                                    check_frames(&frames, &rowids, &tally, "paginated scan");
                                    offset += frames.len();
                                }
                                Ok(_) => break,
                                Err(e) => {
                                    tally.error(format!("paginated scan: {e}"));
                                    break;
                                }
                            }
                        }
                    };
                    let t = Instant::now();
                    let _ = tokio::time::timeout(budget, scan).await;
                    tally.op("paginated scan (dropped)", t.elapsed());
                }
            })
        });
        // Events on X.
        handles.push({
            let (stop, tally, x) = (stop.clone(), tally.clone(), x.clone());
            tokio::spawn(async move {
                let mut n = 0;
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    match capture_db::insert_capture_event(&x, n, 5, "soak").await {
                        Ok(ev) => {
                            if let Err(e) = capture_db::delete_capture_event(&x, &ev.id).await {
                                tally.error(format!("event delete: {e}"));
                            }
                        }
                        Err(e) => tally.error(format!("event insert: {e}")),
                    }
                    tally.op("events", t.elapsed());
                    n += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
        });
        // Sync lifecycle writes from the blocking pool and from a worker (block_in_place).
        handles.push({
            let (stop, tally) = (stop.clone(), tally.clone());
            tokio::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    let mut n = 0;
                    while !stop.load(Ordering::Relaxed) {
                        lifecycle_round("sb", n, &tally, "lifecycle spawn_blocking");
                        n += 1;
                        std::thread::sleep(Duration::from_millis(15));
                    }
                })
                .await
                .unwrap();
            })
        });
        handles.push({
            let (stop, tally) = (stop.clone(), tally.clone());
            tokio::spawn(async move {
                let mut n = 0;
                while !stop.load(Ordering::Relaxed) {
                    lifecycle_round("wk", n, &tally, "lifecycle on a worker");
                    n += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
        });

        tokio::time::sleep(Duration::from_secs(secs)).await;
        stop.store(true, Ordering::Relaxed);
        for h in handles {
            match tokio::time::timeout(Duration::from_secs(60), h).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tally.error(format!("task panicked: {e}")),
                Err(_) => tally.error("a task did not stop within 60 s: HANG".into()),
            }
        }
    });
    std_lifecycle.join().unwrap();
    wal_monitor.join().unwrap();
    let ran = started.elapsed();

    let (x_rows, y_rows, integrity_result) = rt.block_on(async {
        let mut results = Vec::new();
        for (id, written) in [(&x, &written_x), (&y, &written_y)] {
            let (mut after, mut expected, mut ok) = (0i64, 0u64, true);
            loop {
                let chunk = capture_db::read_frame_chunk(id, after, 20_000).await.unwrap();
                if chunk.is_empty() {
                    break;
                }
                for (rowid, f) in &chunk {
                    if *rowid <= after || f.timestamp_us != expected || json(f) != json(&soak_frame(expected)) {
                        tally.error(format!("read-back {id}: rowid {rowid} ts {} expected {expected}", f.timestamp_us));
                        ok = false;
                        break;
                    }
                    after = *rowid;
                    expected += 1;
                }
                if !ok {
                    break;
                }
            }
            let count = capture_db::get_frame_count(id).await.unwrap() as u64;
            if count != written.load(Ordering::Relaxed) || count != expected {
                tally.error(format!("{id}: {count} rows, {} written, {expected} read in order", written.load(Ordering::Relaxed)));
            }
            results.push(count);
        }
        let leftovers = scalar_i64(&store, "SELECT COUNT(*) FROM capture_metadata WHERE capture_id LIKE 'lc_%'").await;
        if leftovers != 0 {
            tally.error(format!("{leftovers} lifecycle captures left"));
        }
        (results[0], results[1], integrity(&store).await)
    });
    let registry_x = capture_store::get_capture_count(&x);
    let wal_before_close = file_len(&sidecar(&db, "-wal"));
    rt.block_on(store.close());
    let wal_after_close = file_len(&sidecar(&db, "-wal"));

    println!("[3] soak ran {ran:?} (target {secs} s) on a 4-worker runtime");
    println!("[3] X (merge path): {x_rows} rows, registry count {registry_x}, written {}", written_x.load(Ordering::Relaxed));
    println!("[3] Y (insert_frames): {y_rows} rows, written {}", written_y.load(Ordering::Relaxed));
    println!("[3] queries: {} completed, {} cancelled", completed_queries.load(Ordering::Relaxed), cancels.load(Ordering::Relaxed));
    let ops = tally.ops.lock().unwrap();
    let waits = tally.max_wait_us.lock().unwrap();
    let mut actors: Vec<_> = ops.keys().collect();
    actors.sort();
    for a in actors {
        println!("[3]   {a:<28} {:>6} ops, longest {:>8.1} ms", ops[a], waits[a] as f64 / 1000.0);
    }
    println!("[3] integrity_check: {integrity_result}");
    println!(
        "[3] max -wal during soak {} bytes; before close {:?}; after close {:?}",
        max_wal.load(Ordering::Relaxed),
        wal_before_close,
        wal_after_close
    );
    let errors = tally.errors.lock().unwrap();
    println!("[3] errors: {}", errors.len());
    for e in errors.iter().take(20) {
        println!("[3]   {e}");
    }
    assert!(errors.is_empty());
    assert_eq!(integrity_result, "ok");
    assert_eq!(registry_x as u64, x_rows);
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 4: pool exhaustion and the sync bridge
// ============================================================================

const POOL: usize = 5;

async fn hold_all(store: &Store) -> Vec<sqlx::pool::PoolConnection<sqlx::Sqlite>> {
    let mut held = Vec::new();
    for _ in 0..POOL {
        held.push(store.database().pool().acquire().await.unwrap());
    }
    held
}

fn sync_write(store: &Store) -> String {
    let t = Instant::now();
    let r = wait(store.update_capture_name("pool", "renamed"));
    format!("{} after {:.2?}", r.map_or_else(|e| format!("ERR {e}"), |()| "OK".into()), t.elapsed())
}

fn long_read_sql(n: u64) -> Sql {
    Sql {
        sql: format!("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < {n}) SELECT COUNT(*) FROM n"),
        values: vec![],
    }
}

fn run_scenario(label: &str, store: &Store, scenario: impl FnOnce(Store) -> String + Send + 'static) {
    let (tx, rx) = mpsc::channel();
    let store = store.clone();
    let started = Instant::now();
    std::thread::spawn(move || {
        let _ = tx.send(scenario(store));
    });
    match rx.recv_timeout(Duration::from_secs(80)) {
        Ok(outcome) => println!("[4] {label}: {outcome} (scenario total {:.2?})", started.elapsed()),
        Err(_) => println!("[4] {label}: NO ANSWER after 80 s: DEADLOCK (thread leaked)"),
    }
}

#[test]
#[ignore]
fn pool_exhaustion_and_the_bridge() {
    let dir = fresh_dir("pool");
    let base = multi_thread(2);
    let store = base.block_on(async { Store::open(dir.join("pool.db")).await.unwrap().0 });
    base.block_on(store.save_capture_metadata(&CaptureMetadata {
        id: "pool".into(),
        kind: CaptureKind::Frames,
        name: "pool".into(),
        count: 0,
        start_time_us: None,
        end_time_us: None,
        created_at: 1,
        is_streaming: false,
        owning_session_id: None,
        persistent: false,
        buses: vec![],
    }))
    .unwrap();
    let t = Instant::now();
    base.block_on(store.read_rows(&long_read_sql(20_000_000), &Cancel::new(), |r| sqlx::Row::try_get::<i64, _>(r, 0))).unwrap();
    println!("[4] a 20M-step read takes {:.2?}", t.elapsed());

    run_scenario("A multi-thread worker, all 5 held for 40 s", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            let held = hold_all(&store).await;
            let s = store.clone();
            let out = tokio::spawn(async move { sync_write(&s) }).await.unwrap();
            drop(held);
            out
        })
    });
    run_scenario("B multi-thread worker, all 5 held, released by a task after 2 s", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            let held = hold_all(&store).await;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(held);
            });
            let s = store.clone();
            tokio::spawn(async move { sync_write(&s) }).await.unwrap()
        })
    });
    run_scenario("C current-thread, all 5 held, released by a task on the same runtime after 2 s", &store, |store| {
        let rt = current_thread();
        rt.block_on(async move {
            let held = hold_all(&store).await;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(held);
            });
            sync_write(&store)
        })
    });
    run_scenario("D current-thread, all 5 acquired and dropped, then a sync write", &store, |store| {
        let rt = current_thread();
        rt.block_on(async move {
            drop(hold_all(&store).await);
            sync_write(&store)
        })
    });
    run_scenario("E multi-thread worker, all 5 acquired and dropped, then a sync write", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            let s = store.clone();
            tokio::spawn(async move {
                drop(hold_all(&s).await);
                sync_write(&s)
            })
            .await
            .unwrap()
        })
    });
    run_scenario("E' one-worker multi-thread runtime, all 5 dropped, then a sync write", &store, |store| {
        let rt = multi_thread(1);
        rt.block_on(async move {
            let s = store.clone();
            tokio::spawn(async move {
                drop(hold_all(&s).await);
                sync_write(&s)
            })
            .await
            .unwrap()
        })
    });
    run_scenario("F multi-thread, 5 long reads in flight, sync write from a worker", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            for _ in 0..POOL {
                let s = store.clone();
                tokio::spawn(async move {
                    let _ = s.read_rows(&long_read_sql(20_000_000), &Cancel::new(), |r| sqlx::Row::try_get::<i64, _>(r, 0)).await;
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            let s = store.clone();
            let worker = tokio::spawn(async move { sync_write(&s) }).await.unwrap();
            let s = store.clone();
            let blocking = tokio::task::spawn_blocking(move || sync_write(&s)).await.unwrap();
            format!("worker {worker}; then spawn_blocking {blocking}")
        })
    });
    run_scenario("F' current-thread, 5 long reads in flight on it, sync write", &store, |store| {
        let rt = current_thread();
        rt.block_on(async move {
            for _ in 0..POOL {
                let s = store.clone();
                tokio::spawn(async move {
                    let _ = s.read_rows(&long_read_sql(20_000_000), &Cancel::new(), |r| sqlx::Row::try_get::<i64, _>(r, 0)).await;
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            sync_write(&store)
        })
    });
    run_scenario("G plain thread, no runtime, all 5 held by another runtime for 3 s", &store, |store| {
        let rt = multi_thread(2);
        let held = rt.block_on(hold_all(&store));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let _inside = rt.enter();
            drop(held);
            drop(_inside);
            rt
        });
        let out = sync_write(&store);
        drop(releaser.join().unwrap());
        out
    });
    run_scenario("H spawn_blocking + Handle::block_on (the transmit forwarders' shape), all 5 held 2 s", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            let held = hold_all(&store).await;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(held);
            });
            let handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || handle.block_on(async move { sync_write(&store) })).await.unwrap()
        })
    });
    run_scenario("I multi-thread worker, the writer held, released by a task after 2 s", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            let held = store.database().writer().acquire().await.unwrap();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(held);
            });
            let s = store.clone();
            tokio::spawn(async move { sync_write(&s) }).await.unwrap()
        })
    });
    run_scenario("I' current-thread, the writer held, released by a task on the same runtime after 2 s", &store, |store| {
        let rt = current_thread();
        rt.block_on(async move {
            let held = store.database().writer().acquire().await.unwrap();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(held);
            });
            sync_write(&store)
        })
    });
    run_scenario("W current-thread, one async write on it, then a sync write", &store, |store| {
        let rt = current_thread();
        rt.block_on(async move {
            store.update_capture_name("pool", "async").await.unwrap();
            sync_write(&store)
        })
    });
    run_scenario("W' multi-thread worker, one async write on it, then a sync write", &store, |store| {
        let rt = multi_thread(4);
        rt.block_on(async move {
            tokio::spawn(async move {
                store.update_capture_name("pool", "async").await.unwrap();
                sync_write(&store)
            })
            .await
            .unwrap()
        })
    });
    let after = base.block_on(async { (store.database().pool().size(), store.database().pool().num_idle(), integrity(&store).await) });
    println!("[4] pool afterwards: size {}, idle {}, integrity {}", after.0, after.1, after.2);
    println!("[4] writer afterwards: size {}, idle {}", store.database().writer().size(), store.database().writer().num_idle());
    let t = Instant::now();
    println!("[4] a final sync write: {} ({:.2?})", sync_write(&store), t.elapsed());
}

// ============================================================================
// 5: cancel and drop hygiene
// ============================================================================

/// Every pooled connection: writable, not read-only, foreign keys on, not in a
/// transaction, and not interrupted by a stale progress handler.
async fn probe_every_connection(store: &Store) -> Result<(), String> {
    let mut held = Vec::new();
    for _ in 0..POOL {
        held.push(store.database().pool().acquire().await.map_err(|e| format!("acquire: {e}"))?);
    }
    held.push(store.database().writer().acquire().await.map_err(|e| format!("acquire the writer: {e}"))?);
    for (i, conn) in held.iter_mut().enumerate() {
        let c = &mut **conn;
        let query_only: i64 = sqlx::query_scalar("PRAGMA query_only").fetch_one(&mut *c).await.map_err(|e| e.to_string())?;
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut *c).await.map_err(|e| e.to_string())?;
        let long: Result<i64, _> = sqlx::query_scalar("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50000) SELECT COUNT(*) FROM n")
            .fetch_one(&mut *c)
            .await;
        let begin = sqlx::query("BEGIN IMMEDIATE").execute(&mut *c).await;
        let write = sqlx::query("INSERT INTO bytes (capture_id, byte_val, timestamp_us) VALUES ('probe', 1, 1)").execute(&mut *c).await;
        let rollback = sqlx::query("ROLLBACK").execute(&mut *c).await;
        if query_only != 0 || foreign_keys != 1 || long.is_err() || begin.is_err() || write.is_err() || rollback.is_err() {
            return Err(format!(
                "connection {i}: query_only {query_only}, foreign_keys {foreign_keys}, long {long:?}, begin {begin:?}, write {:?}, rollback {:?}",
                write.map(|_| ()),
                rollback.map(|_| ())
            ));
        }
    }
    Ok(())
}

/// Who holds the write lock, seen from a separate sqlite3 process that will not wait for it.
fn write_lock_held(db: &Path) -> Option<String> {
    let (_, err) = sqlite3_raw(db, "BEGIN IMMEDIATE; ROLLBACK;");
    (!err.trim().is_empty()).then(|| err.trim().to_string())
}

/// Polls `fut` `polls` times, spinning `spin_us` between polls, then drops it.
async fn poll_then_drop<F: std::future::Future>(fut: F, polls: u64, spin_us: u64) -> bool {
    let mut fut = std::pin::pin!(fut);
    for _ in 0..polls {
        let ready = std::future::poll_fn(|cx| std::task::Poll::Ready(fut.as_mut().poll(cx).is_ready())).await;
        if ready {
            return true;
        }
        let until = Instant::now() + Duration::from_micros(spin_us);
        while Instant::now() < until {
            std::hint::spin_loop();
        }
    }
    false
}

#[test]
#[ignore]
fn cancel_and_drop_hygiene() {
    let iterations: u64 = std::env::var("HYGIENE_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let _dog = watchdog("cancel_and_drop_hygiene", Duration::from_secs(1800));
    let dir = fresh_dir("hygiene");
    let rt = multi_thread(4);
    let db_path = dir.join("hygiene.db");
    let skip_b = std::env::var("HYGIENE_SKIP_AB").is_ok();
    rt.block_on(async {
        let (store, _) = Store::open(&db_path).await.unwrap();
        for chunk in 0..20 {
            store.insert_frames("h", &batch(chunk * 10_000, 10_000)).await.unwrap();
        }
        let long = long_read_sql(500_000_000);
        let first = |r: &sqlx::sqlite::SqliteRow| sqlx::Row::try_get::<i64, _>(r, 0);
        let mut rng = Rng::seeded();
        let mut failures: Vec<String> = Vec::new();

        // a) cancel mid-statement, then writes and reads at once.
        let (mut cancelled, mut other) = (0, 0);
        let t = Instant::now();
        for i in 0..if skip_b { 0 } else { 300 } {
            let cancel = Cancel::new();
            let after = rng.range(0, 30);
            let flag = cancel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(after));
                flag.cancel();
            });
            match store.read_rows(&long, &cancel, first).await {
                Err(CaptureError::Cancelled) => cancelled += 1,
                r => {
                    other += 1;
                    failures.push(format!("a{i}: {r:?}"));
                }
            }
            for _ in 0..5 {
                if let Err(e) = store.insert_frames("h_after", &batch(0, 1)).await {
                    failures.push(format!("a{i} write: {e}"));
                }
                if let Err(e) = store.get_frame_count("h").await {
                    failures.push(format!("a{i} read: {e}"));
                }
            }
            if let Err(e) = probe_every_connection(&store).await {
                failures.push(format!("a{i} probe: {e}"));
            }
        }
        println!("[5a] 300 mid-statement cancels: {cancelled} Cancelled, {other} other ({:.2?}); failures so far {}", t.elapsed(), failures.len());

        // b) drop read_rows mid-flight at every point from the acquire to the fetch.
        let t = Instant::now();
        let mut finished = 0;
        let before = failures.len();
        for i in 0..if skip_b { 0 } else { iterations } {
            let polls = rng.range(1, 6);
            let spin = if i % 2 == 0 { rng.range(0, 60) } else { rng.range(0, 2000) };
            if poll_then_drop(store.read_rows(&long, &Cancel::new(), first), polls, spin).await {
                finished += 1;
            }
            if let Err(e) = probe_every_connection(&store).await {
                if failures.len() - before < 5 {
                    println!("[5b]   b{i} (polls {polls}, spin {spin} us) probe: {e}");
                }
                failures.push(format!("b{i} (polls {polls}, spin {spin} us) probe: {e}"));
            }
        }
        println!(
            "[5b] {iterations} read_rows futures dropped mid-flight ({finished} finished first): {} probe failures ({:.2?})",
            failures.len() - before,
            t.elapsed()
        );

        // c) drop a 1000-frame insert mid-flight: all or nothing, and the next write works.
        let t = Instant::now();
        let before = failures.len();
        let mut committed = 0u64;
        for i in 0..500u64 {
            let polls = rng.range(1, 40);
            let spin = rng.range(0, 500);
            if poll_then_drop(store.insert_frames("h_tx", &batch(i * 1000, 1000)), polls, spin).await {
                committed += 1;
            }
            let count = store.get_frame_count("h_tx").await.unwrap();
            if count % 1000 != 0 {
                failures.push(format!("c{i}: h_tx holds {count} rows, not whole batches"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
            if let Some(holder) = write_lock_held(&db_path) {
                println!("[5c]   c{i} (polls {polls}, spin {spin} us): after the drop the write lock is still held: {holder}");
                let t = Instant::now();
                let next = store.insert_frames("h_after", &batch(0, 1)).await;
                println!("[5c]   the next insert_frames: {next:?} after {:.2?}", t.elapsed());
                let t = Instant::now();
                let mut results = Vec::new();
                for _ in 0..POOL {
                    results.push(format!("{:?}", store.insert_frames("h_after", &batch(0, 1)).await.map_err(|e| e.to_string())));
                }
                println!("[5c]   {POOL} more inserts: {results:?} in {:.2?}", t.elapsed());
                let (pool, writer) = (store.database().pool(), store.database().writer());
                println!("[5c]   pool size {}, idle {}; writer size {}, idle {}", pool.size(), pool.num_idle(), writer.size(), writer.num_idle());
                failures.push(format!("c{i}: write lock leaked by a dropped insert"));
                break;
            }
            if let Err(e) = store.insert_frames("h_after", &batch(0, 1)).await {
                failures.push(format!("c{i} write after drop: {e}"));
            }
        }
        let count = store.get_frame_count("h_tx").await.unwrap();
        println!(
            "[5c] 500 inserts dropped mid-flight: {committed} finished, {count} rows ({} whole batches); failures {} ({:.2?})",
            count / 1000,
            failures.len() - before,
            t.elapsed()
        );
        if let Err(e) = probe_every_connection(&store).await {
            failures.push(format!("c probe: {e}"));
        }

        // d) drop a plain paginated read mid-flight.
        let before = failures.len();
        for i in 0..500 {
            let polls = rng.range(1, 6);
            let spin = rng.range(0, 300);
            poll_then_drop(store.get_frames_paginated("h", 100_000, 50_000), polls, spin).await;
            if let Err(e) = probe_every_connection(&store).await {
                failures.push(format!("d{i} probe: {e}"));
            }
        }
        println!("[5d] 500 paginated reads dropped mid-flight: {} probe failures", failures.len() - before);
        println!("[5] integrity_check: {}", integrity(&store).await);
        println!("[5] failures: {}", failures.len());
        for f in failures.iter().take(15) {
            println!("[5]   {f}");
        }
        store.close().await;
        assert!(failures.is_empty());
    });
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 6: crash safety (children re-exec this binary)
// ============================================================================

fn spawn_child(test: &str, env: &str, path: &Path) -> (std::process::Child, mpsc::Receiver<String>) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([test, "--exact", "--ignored", "--nocapture", "--test-threads=1"])
        .env(env, path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    (child, rx)
}

fn wait_for_line(rx: &mpsc::Receiver<String>, prefix: &str) -> String {
    loop {
        let line = rx.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| panic!("no {prefix} line from the child"));
        if let Some(at) = line.find(prefix) {
            return line[at..].to_string();
        }
    }
}

#[test]
#[ignore]
fn crash_child_append() {
    let Ok(path) = std::env::var("SOAK_CHILD_APPEND") else { return };
    current_thread().block_on(async {
        let (store, _) = Store::open(&path).await.unwrap();
        let _own = capture_db::use_own_store(store);
        let mut seq = capture_db::get_frame_count("crash").await.unwrap() as u64;
        println!("READY {seq}");
        loop {
            capture_db::insert_frames("crash", &batch(seq, 100)).await.unwrap();
            seq += 100;
            println!("C {seq}");
        }
    });
}

#[test]
#[ignore]
fn crash_kill_mid_append() {
    let iterations: usize = std::env::var("CRASH_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(25);
    let dir = fresh_dir("crash-append");
    let db = dir.join("crash.db");
    let rt = current_thread();
    let mut rng = Rng::seeded();
    let mut failures = Vec::new();
    for i in 0..iterations {
        let (mut child, rx) = spawn_child("sqlite_soak::crash_child_append", "SOAK_CHILD_APPEND", &db);
        let ready = wait_for_line(&rx, "READY");
        let kill_after = rng.range(20, 400);
        std::thread::sleep(Duration::from_millis(kill_after));
        child.kill().unwrap();
        child.wait().unwrap();
        let mut last_reported = ready[6..].parse::<u64>().unwrap();
        while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
            if let Some(n) = line.strip_prefix("C ") {
                last_reported = n.parse().unwrap();
            }
        }
        let wal_at_kill = file_len(&sidecar(&db, "-wal"));
        let (count, contiguous, integrity_result, tail_ok) = rt.block_on(async {
            let (store, _) = Store::open(&db).await.unwrap();
            let count = store.get_frame_count("crash").await.unwrap() as i64;
            let shape = scalar_i64(&store, "SELECT (MIN(timestamp_us) = 0 AND MAX(timestamp_us) = COUNT(*) - 1 AND COUNT(DISTINCT timestamp_us) = COUNT(*)) FROM frames WHERE capture_id = 'crash'").await;
            let (tail, _) = store.get_frames_tail_rows("crash", 300).await.unwrap();
            let tail_ok = tail.iter().all(|f| json(&FrameMessage::from(f.clone())) == json(&soak_frame(f.timestamp_us)));
            let integrity_result = integrity(&store).await;
            store.close().await;
            (count as u64, shape == 1, integrity_result, tail_ok)
        });
        let ok = count % 100 == 0 && count >= last_reported && count <= last_reported + 100 && contiguous && tail_ok && integrity_result == "ok";
        println!(
            "[6a] kill {i:>2} after {kill_after:>3} ms: last reported commit {last_reported:>7}, rows after reopen {count:>7}, -wal at kill {wal_at_kill:?}, integrity {integrity_result}, contiguous {contiguous}, payloads {tail_ok} -> {}",
            if ok { "ok" } else { "FAIL" }
        );
        if !ok {
            failures.push(i);
        }
    }
    let final_count = rt.block_on(async {
        let (store, _) = Store::open(&db).await.unwrap();
        let n = store.get_frame_count("crash").await.unwrap() as u64;
        store.insert_frames("crash", &batch(n, 100)).await.unwrap();
        let after = store.get_frame_count("crash").await.unwrap() as u64;
        store.close().await;
        (n, after)
    });
    println!("[6a] after {iterations} kills: {} rows; a further batch makes {}", final_count.0, final_count.1);
    assert!(failures.is_empty(), "failed iterations {failures:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
#[ignore]
fn crash_child_open() {
    let Ok(path) = std::env::var("SOAK_CHILD_OPEN") else { return };
    current_thread().block_on(async {
        println!("OPENING");
        let t = Instant::now();
        let (store, applied) = Store::open(&path).await.unwrap();
        println!("OPENED {} us, applied {}", t.elapsed().as_micros(), applied.len());
        std::mem::forget(store);
        tokio::time::sleep(Duration::from_secs(3600)).await;
    });
}

fn header_user_version(db: &Path) -> Option<u32> {
    let bytes = std::fs::read(db).ok()?;
    bytes.get(60..64).map(|b| u32::from_be_bytes(b.try_into().unwrap()))
}

#[test]
#[ignore]
fn crash_kill_mid_upgrade() {
    let iterations: usize = std::env::var("CRASH_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(25);
    let kill_from_us: u64 = std::env::var("KILL_FROM_US").ok().and_then(|s| s.parse().ok()).unwrap_or(1_000);
    let kill_to_us: u64 = std::env::var("KILL_TO_US").ok().and_then(|s| s.parse().ok()).unwrap_or(15_000);
    let dir = fresh_dir("crash-upgrade");
    let reference = dir.join("reference.db");
    copy_writable(&pristine(), &reference);
    let expected = digests(&reference);
    let rt = current_thread();
    let mut rng = Rng::seeded();
    let mut failures = Vec::new();
    let mut states: HashMap<String, usize> = HashMap::new();

    let calibrate = dir.join("calibrate.db");
    copy_writable(&pristine(), &calibrate);
    let (mut child, rx) = spawn_child("sqlite_soak::crash_child_open", "SOAK_CHILD_OPEN", &calibrate);
    println!("[6b] unkilled open: {}", wait_for_line(&rx, "OPENED"));
    child.kill().unwrap();
    child.wait().unwrap();
    std::fs::remove_file(&calibrate).ok();

    for i in 0..iterations {
        let db = dir.join(format!("up{i}.db"));
        copy_writable(&pristine(), &db);
        let (mut child, rx) = spawn_child("sqlite_soak::crash_child_open", "SOAK_CHILD_OPEN", &db);
        wait_for_line(&rx, "OPENING");
        let kill_after = rng.range(kill_from_us, kill_to_us);
        std::thread::sleep(Duration::from_micros(kill_after));
        child.kill().unwrap();
        child.wait().unwrap();
        let finished = std::iter::from_fn(|| rx.recv_timeout(Duration::from_millis(100)).ok()).any(|l| l.contains("OPENED"));
        let state = format!(
            "user_version {:?}, -journal {}, -wal {:?}, finished {finished}",
            header_user_version(&db),
            sidecar(&db, "-journal").exists(),
            file_len(&sidecar(&db, "-wal")),
        );
        *states.entry(state.clone()).or_default() += 1;
        let reopened = rt.block_on(async {
            let (store, applied) = Store::open(&db).await.map_err(|e| e.to_string())?;
            let integrity_result = integrity(&store).await;
            store.close().await;
            Ok::<_, String>((applied.iter().map(|m| m.version).collect::<Vec<_>>(), integrity_result))
        });
        let verdict = match reopened {
            Err(e) => format!("REOPEN FAILED: {e}"),
            Ok((applied, integrity_result)) => {
                let digests_now = digests(&db);
                let user_version = sqlite3(&db, "PRAGMA user_version");
                let journal = sqlite3(&db, "PRAGMA journal_mode");
                let crc = sqlite3(&db, "SELECT COUNT(*) FROM pragma_table_info('frames') WHERE name = 'crc_valid'");
                let chain = sqlite3(&db, "SELECT group_concat(version) FROM _capture_migrations");
                let ok = integrity_result == "ok" && digests_now == expected && user_version == "6" && journal == "wal" && crc == "1" && chain == "1";
                format!(
                    "reopen applied legacy {applied:?}, integrity {integrity_result}, digests {}, user_version {user_version}, journal {journal}, chain [{chain}] -> {}",
                    if digests_now == expected { "equal" } else { "DIFFER" },
                    if ok { "ok" } else { "FAIL" }
                )
            }
        };
        println!("[6b] kill {i:>2} after {kill_after:>5} us: {state}; {verdict}");
        if !verdict.ends_with("ok") {
            failures.push(i);
        }
        for suffix in ["", "-wal", "-shm", "-journal"] {
            std::fs::remove_file(sidecar(&db, suffix)).ok();
        }
    }
    println!("[6b] states at kill: {states:#?}");
    assert!(failures.is_empty(), "failed iterations {failures:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 7: old-app compatibility, emulated with the sqlite3 CLI
// ============================================================================

const OLD_MIGRATIONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../wiretap-capture-store/legacy");

#[test]
#[ignore]
fn old_app_compatibility() {
    let dir = fresh_dir("old-app");
    let db = dir.join("upgraded.db");
    copy_writable(&pristine(), &db);
    let rt = current_thread();
    rt.block_on(async {
        let (store, _) = Store::open(&db).await.unwrap();
        store.close().await;
    });
    let before = digests(&db);
    println!("[7] upgraded file: user_version {}, journal {}", sqlite3(&db, "PRAGMA user_version"), sqlite3(&db, "PRAGMA journal_mode"));
    println!("[7] old migrate (v0.10.2) applies MIGRATIONS with version > user_version: the ladder tops at 6, so none run");

    // The old app's open, statement for statement: migrate's preamble, then sweep, then tune.
    let old_open = "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
        PRAGMA journal_mode=DELETE;
        DELETE FROM frames WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 0);
        DELETE FROM bytes WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 0);
        DELETE FROM capture_events WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 0);
        DELETE FROM capture_metadata WHERE persistent = 0;
        DELETE FROM frames WHERE capture_id NOT IN (SELECT capture_id FROM capture_metadata);
        DELETE FROM bytes WHERE capture_id NOT IN (SELECT capture_id FROM capture_metadata);
        DELETE FROM capture_events WHERE capture_id NOT IN (SELECT capture_id FROM capture_metadata);
        VACUUM;
        PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;
        INSERT INTO capture_metadata (capture_id, capture_kind, name, count, created_at, persistent, buses) VALUES ('oldapp', 'frames', 'old app', 1, 1, 1, '[0]');
        INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, is_rtr, is_brs, is_esi, source_address, incomplete, direction, crc_valid)
            VALUES ('oldapp', 'can', 1, 256, 0, 8, x'0102030405060708', 0, 0, 0, 0, 0, NULL, NULL, 'rx', NULL);";
    let (out, err) = sqlite3_raw(&db, old_open);
    println!("[7] old app's open + sweep + tune + insert on the upgraded file: stdout {:?}, stderr {:?}", out.trim(), err.trim());
    assert!(err.is_empty());
    println!("[7] after the old app: user_version {}, journal {}, integrity {}", sqlite3(&db, "PRAGMA user_version"), sqlite3(&db, "PRAGMA journal_mode"), sqlite3(&db, "PRAGMA integrity_check"));
    let reopened = rt.block_on(async {
        let (store, applied) = Store::open(&db).await.map_err(|e| e.to_string())?;
        let n = store.get_frame_count("oldapp").await.unwrap();
        let i = integrity(&store).await;
        store.close().await;
        Ok::<_, String>((applied.len(), n, i))
    });
    println!("[7] the new app reopens it: {reopened:?}");
    let after: Digests = digests(&db).into_iter().filter(|(t, _, _)| t != "frames" && t != "capture_metadata").collect();
    let before_rest: Digests = before.into_iter().filter(|(t, _, _)| t != "frames" && t != "capture_metadata").collect();
    println!("[7] bytes/events/schema_migrations unchanged through old app and reopen: {}", after == before_rest);
    println!(
        "[7] frames: {} rows ({} of pinned captures kept + 1 old-app row)",
        sqlite3(&db, "SELECT COUNT(*) FROM frames"),
        sqlite3(&db, "SELECT COUNT(*) FROM frames WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 1 AND capture_id != 'oldapp')")
    );

    // A fresh file the new app made, unstamped: the window between the chain's commit and the stamp.
    let fresh = dir.join("fresh.db");
    rt.block_on(async {
        let (store, _) = Store::open(&fresh).await.unwrap();
        store.close().await;
    });
    println!("[7] fresh new-app file: user_version {}, schema_migrations table: {}", sqlite3(&fresh, "PRAGMA user_version"), sqlite3(&fresh, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'"));
    sqlite3(&fresh, "PRAGMA user_version = 0");
    for step in ["0002_frames_capture_rowid_index", "0003_frames_fid_protocol_index", "0004_capture_events", "0005_frames_can_flags"] {
        let sql = std::fs::read_to_string(Path::new(OLD_MIGRATIONS).join(format!("{step}.sql"))).unwrap();
        let (_, err) = sqlite3_raw(&fresh, &format!("BEGIN; {sql} COMMIT;"));
        println!("[7] old ladder step {step} on an unstamped new-app file: {}", if err.is_empty() { "ok".into() } else { err.trim().to_string() });
        if !err.is_empty() {
            sqlite3_raw(&fresh, "ROLLBACK");
            break;
        }
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 8: transmit history
// ============================================================================

#[test]
#[ignore]
fn transmit_history_real_file() {
    let dir = fresh_dir("transmit");
    let digest_dir = fresh_dir("transmit-digest");
    for suffix in ["", "-wal", "-shm"] {
        let from = sidecar(&real_file("transmit_history-copy.db"), suffix);
        copy_writable(&from, &sidecar(&dir.join("transmit_history.db"), suffix));
        copy_writable(&from, &sidecar(&digest_dir.join("t.db"), suffix));
    }
    let cols = ["id", "session_id", "timestamp_us", "kind", "frame_id", "dlc", "bytes", "bus", "is_extended", "is_fd", "success", "error_msg"];
    let reference = digest_dir.join("t.db");
    let max_id = sqlite3(&reference, "SELECT MAX(id) FROM transmit_history");
    let filter = format!("WHERE id <= {max_id}");
    let before = table_digest(&reference, "transmit_history", &cols, &filter);
    let seq_before = sqlite3(&reference, "SELECT * FROM sqlite_sequence");
    println!("[8] before: {} rows, sha {}, sqlite_sequence {seq_before}, user_version {}, journal {}", before.0, &before.1[..16], sqlite3(&reference, "PRAGMA user_version"), sqlite3(&reference, "PRAGMA journal_mode"));

    let t = Instant::now();
    crate::transmit_history::initialise(&dir).unwrap();
    println!("[8] initialise took {:.2?}", t.elapsed());
    let db = dir.join("transmit_history.db");
    let after = table_digest(&db, "transmit_history", &cols, &filter);
    println!("[8] after open: {} rows, sha {} -> {}", after.0, &after.1[..16], if after == before { "equal" } else { "DIFFER" });
    println!("[8] integrity {}, user_version {}, journal {}, tables {}", sqlite3(&db, "PRAGMA integrity_check"), sqlite3(&db, "PRAGMA user_version"), sqlite3(&db, "PRAGMA journal_mode"), sqlite3(&db, "SELECT group_concat(name, ', ') FROM sqlite_master WHERE type = 'table'"));
    println!("[8] _transmit_history_migrations: {}", sqlite3(&db, "SELECT version, description, installed_on FROM _transmit_history_migrations"));
    println!("[8] file modes: db {:?}, -wal {:?}, -shm {:?}", file_mode(&db), file_mode(&sidecar(&db, "-wal")), file_mode(&sidecar(&db, "-shm")));
    assert_eq!(after, before);

    let rt = current_thread();
    let rows = rt.block_on(async {
        crate::transmit_history::write_entry("soak_session", "can", Some(0x123), Some(8), &[1, 2, 3, 4, 5, 6, 7, 8], 1, true, false, true, None).await;
        let count = crate::transmit_history::transmit_history_count("soak_session".into()).await.unwrap();
        let rows = crate::transmit_history::transmit_history_query("soak_session".into(), 0, 10).await.unwrap();
        (count, rows)
    });
    println!("[8] appended and read back: count {}, row {:?}", rows.0, rows.1.first());
    assert_eq!(rows.0, 1);
    let row = &rows.1[0];
    assert_eq!((row.frame_id, row.dlc, row.bytes.as_slice(), row.bus, row.is_extended), (Some(0x123), Some(8), &[1u8, 2, 3, 4, 5, 6, 7, 8][..], 1, true));
    println!("[8] new row id {} (max before {max_id}), sqlite_sequence now {}", row.id, sqlite3(&db, "SELECT * FROM sqlite_sequence"));
    let final_digest = table_digest(&db, "transmit_history", &cols, &filter);
    assert_eq!(final_digest, before);
    println!("[8] original rows unchanged after the append; integrity {}", sqlite3(&db, "PRAGMA integrity_check"));
    std::fs::remove_dir_all(&digest_dir).unwrap();
}

// ============================================================================
// 9: write-lock starvation of the live path
// ============================================================================

struct Writer {
    stop: Arc<AtomicBool>,
    max_wait_us: Arc<AtomicU64>,
    batches: Arc<AtomicU64>,
    direct_errors: Arc<Mutex<Vec<String>>>,
    handles: Vec<tokio::task::JoinHandle<()>>,
}

/// The merge task's append every 10 ms, plus a twin through insert_frames whose errors show.
fn start_writer(session: &'static str, direct: &'static str) -> Writer {
    let w = Writer {
        stop: Arc::default(),
        max_wait_us: Arc::default(),
        batches: Arc::default(),
        direct_errors: Arc::default(),
        handles: Vec::new(),
    };
    let mut handles = Vec::new();
    {
        let (stop, max_wait, batches) = (w.stop.clone(), w.max_wait_us.clone(), w.batches.clone());
        handles.push(tokio::spawn(async move {
            let mut seq = 0;
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                capture_store::append_frames_to_session(session, batch(seq, 100)).await;
                max_wait.fetch_max(t.elapsed().as_micros() as u64, Ordering::Relaxed);
                batches.fetch_add(1, Ordering::Relaxed);
                seq += 100;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }));
    }
    {
        let (stop, errors) = (w.stop.clone(), w.direct_errors.clone());
        handles.push(tokio::spawn(async move {
            let mut seq = 0;
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                if let Err(e) = capture_db::insert_frames(direct, &batch(seq, 100)).await {
                    errors.lock().unwrap().push(format!("{e} (after {:.2?})", t.elapsed()));
                }
                seq += 100;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }));
    }
    Writer { handles, ..w }
}

async fn stop_writer(w: Writer, session_capture: &str) -> String {
    w.stop.store(true, Ordering::Relaxed);
    for h in w.handles {
        h.await.unwrap();
    }
    let registry = capture_store::get_capture_count(session_capture);
    let rows = capture_db::get_frame_count(session_capture).await.unwrap();
    let errors = w.direct_errors.lock().unwrap().clone();
    format!(
        "{} batches, longest append {:.1} ms, registry count {registry}, rows {rows}, LOST {}; direct insert errors {}: {:?}",
        w.batches.load(Ordering::Relaxed),
        w.max_wait_us.load(Ordering::Relaxed) as f64 / 1000.0,
        registry as i64 - rows as i64,
        errors.len(),
        errors.iter().take(3).collect::<Vec<_>>()
    )
}

async fn timed<T>(label: &str, f: impl std::future::Future<Output = Result<T, String>>) -> Option<T> {
    let t = Instant::now();
    let r = f.await;
    println!("[9]   {label}: {:.2?} {}", t.elapsed(), r.as_ref().err().map_or("ok".to_string(), |e| format!("ERR {e}")));
    r.ok()
}

async fn heavy_ops(big: &str, refill: &[FrameMessage]) {
    timed("copy_capture_data", capture_db::copy_capture_data(big, "big_copy")).await;
    timed("delete_capture_data (the copy)", capture_db::delete_capture_data("big_copy")).await;
    timed(&format!("clear_and_refill ({} frames)", refill.len()), capture_db::clear_and_refill(big, refill)).await;
}

async fn heavy_ops_under_writer(big: &str, refill: &[FrameMessage], run: usize) {
    let ops: [(&str, usize); 3] = [("copy_capture_data", 0), ("delete_capture_data (the copy)", 1), ("clear_and_refill", 2)];
    for (label, which) in ops {
        let session: &'static str = Box::leak(format!("starve_{run}_{which}").into_boxed_str());
        let direct: &'static str = Box::leak(format!("starve_direct_{run}_{which}").into_boxed_str());
        let capture = capture_store::create_session_capture(session, CaptureKind::Frames, label.into());
        let writer = start_writer(session, direct);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let watched: &'static str = if which == 2 { Box::leak(big.to_string().into_boxed_str()) } else { "big_copy" };
        let sampler = sample_counts(watched);
        match which {
            0 => timed(label, capture_db::copy_capture_data(big, "big_copy")).await.map(|_| ()),
            1 => timed(label, capture_db::delete_capture_data("big_copy")).await,
            _ => timed(label, capture_db::clear_and_refill(big, refill)).await,
        };
        println!("[9]     a reader polling {watched}'s row count during {label}: {}", sampler.finish().await);
        tokio::time::sleep(Duration::from_secs(1)).await;
        println!("[9]     writer during {label}: {}", stop_writer(writer, &capture).await);
    }
}

struct Sampler {
    stop: Arc<AtomicBool>,
    handle: tokio::task::JoinHandle<Vec<usize>>,
}

/// Polls a capture's row count every 5 ms; what a reader sees while a heavy op runs.
fn sample_counts(capture_id: &'static str) -> Sampler {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = tokio::spawn(async move {
        let mut seen = Vec::new();
        while !flag.load(Ordering::Relaxed) {
            if let Ok(n) = capture_db::get_frame_count(capture_id).await {
                if seen.last() != Some(&n) {
                    seen.push(n);
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        seen
    });
    Sampler { stop, handle }
}

impl Sampler {
    async fn finish(self) -> String {
        self.stop.store(true, Ordering::Relaxed);
        let seen = self.handle.await.unwrap();
        let rising = seen.windows(2).all(|w| w[0] <= w[1]);
        let falling = seen.windows(2).all(|w| w[0] >= w[1]);
        let shape = if seen.len() <= 2 { "no partial state" } else if rising { "grows" } else if falling { "shrinks" } else { "shrinks then grows" };
        format!(
            "{} distinct counts ({shape}): first {:?}, last {:?}, min {:?}, max {:?}",
            seen.len(),
            seen.first(),
            seen.last(),
            seen.iter().min(),
            seen.iter().max()
        )
    }
}

async fn readers_under_writer(big: &'static str, readers: usize, kind: &'static str, run: usize) {
    let session: &'static str = Box::leak(format!("readers_{run}").into_boxed_str());
    let direct: &'static str = Box::leak(format!("readers_direct_{run}").into_boxed_str());
    let capture = capture_store::create_session_capture(session, CaptureKind::Frames, "readers".into());
    let writer = start_writer(session, direct);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let t = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..readers {
        handles.push(tokio::spawn(async move {
            let t = Instant::now();
            let r = match kind {
                "get_all_frames" => capture_db::get_all_frames(big).await.map(|f| f.len()),
                _ => capture_db::read_rows(
                    &Sql {
                        sql: "SELECT COUNT(*), SUM(length(payload) + timestamp_us % 7) FROM frames WHERE capture_id = ?".into(),
                        values: vec![wiretap_capture_store::SqlValue::Text(big.into())],
                    },
                    &Cancel::new(),
                    |r| sqlx::Row::try_get::<i64, _>(r, 0),
                )
                .await
                .map(|v| v[0] as usize),
            };
            (r, t.elapsed())
        }));
    }
    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.unwrap());
    }
    let elapsed = t.elapsed();
    tokio::time::sleep(Duration::from_millis(500)).await;
    println!(
        "[9]   {readers} concurrent {kind} readers: all done in {elapsed:.2?}; each {:?}",
        results.iter().map(|(r, d)| format!("{} in {d:.1?}", r.as_ref().map_or_else(|e| format!("ERR {e}"), |n| n.to_string()))).collect::<Vec<_>>()
    );
    println!("[9]     writer meanwhile: {}", stop_writer(writer, &capture).await);
}

fn starvation(dir: &Path, big: &'static str, refill_cap: usize, reader_kind: &'static str, synthesise: Option<usize>) {
    let rt = multi_thread(4);
    rt.block_on(async {
        let store = capture_db::current();
        if let Some(n) = synthesise {
            resynthesise(&store, big, n).await;
        }
        let count = capture_db::get_frame_count(big).await.unwrap();
        println!("[9] big capture {big}: {count} frames; db {:?} bytes", file_len(&dir.join("buffers.db")));
        let refill: Vec<FrameMessage> = if count <= refill_cap {
            capture_db::get_all_frames(big).await.unwrap()
        } else {
            batch(0, refill_cap as u64)
        };
        println!("[9] (a/b) alone:");
        heavy_ops(big, &refill).await;
        if count > refill_cap {
            resynthesise(&store, big, count).await;
        }
        println!("[9] (c) under a live writer (100 frames every 10 ms):");
        heavy_ops_under_writer(big, &refill, 0).await;
        if count > refill_cap {
            resynthesise(&store, big, count).await;
        }
        println!("[9] (d) concurrent long readers under a live writer:");
        readers_under_writer(big, 5, reader_kind, 1).await;
        readers_under_writer(big, 10, reader_kind, 2).await;
        println!("[9] integrity {}", integrity(&store).await);
        store.close().await;
    });
}

async fn resynthesise(store: &Store, big: &str, count: usize) {
    let t = Instant::now();
    let pool = store.database().pool();
    sqlx::query("DELETE FROM frames WHERE capture_id = ?").bind(big).execute(pool).await.unwrap();
    sqlx::query(&format!(
        "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
         WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < {}) SELECT ?, 'can', x, 256 + x % 64, x % 2, 8, randomblob(8) FROM n",
        count - 1
    ))
    .bind(big)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool).await.unwrap();
    println!("[9]   (synthesised {count} frames in {:.2?})", t.elapsed());
}

#[test]
#[ignore]
fn lock_starvation_real() {
    let _dog = watchdog("lock_starvation_real", Duration::from_secs(1200));
    let dir = fresh_dir("starve-real");
    copy_writable(&pristine(), &dir.join("buffers.db"));
    capture_db::initialise(&dir, false).unwrap();
    starvation(&dir, "dul8kj", usize::MAX, "get_all_frames", None);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
#[ignore]
fn lock_starvation_synthetic() {
    let n: usize = std::env::var("STARVE_FRAMES").ok().and_then(|s| s.parse().ok()).unwrap_or(4_000_000);
    let _dog = watchdog("lock_starvation_synthetic", Duration::from_secs(2400));
    let dir = fresh_dir("starve-synth");
    capture_db::initialise(&dir, false).unwrap();
    starvation(&dir, "big", 1_000_000, "aggregate read_rows", Some(n));
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 10: what the app shows while a windowed copy, refill or delete is part-way
// ============================================================================

async fn app_view(id: &str, new_base: u64) -> String {
    let registry = capture_store::get_capture_count(id);
    let rows = capture_db::get_frame_count(id).await.unwrap_or(usize::MAX);
    let relation = match rows.cmp(&registry) {
        std::cmp::Ordering::Equal => "rows = registry",
        std::cmp::Ordering::Less => "rows < registry",
        std::cmp::Ordering::Greater => "rows > registry",
    };
    let tail = match capture_store::get_capture_frames_tail(id, 50, &FrameSelection::default()).await {
        Err(e) => format!("ERR {e}"),
        Ok(t) if t.frames.is_empty() => "empty".into(),
        Ok(t) => {
            let new = t.frames.iter().filter(|f| f.timestamp_us >= new_base).count();
            if new == t.frames.len() { "new" } else if new == 0 { "old" } else { "mixed" }.into()
        }
    };
    let last_page = match capture_store::get_capture_frames_paginated(id, registry.saturating_sub(50), 50).await {
        Ok((f, _, _)) if f.is_empty() => "empty".to_string(),
        Ok((f, _, _)) => format!("{} rows", f.len()),
        Err(e) => format!("ERR {e}"),
    };
    format!("{relation}, tail {tail}, last registry page {last_page}")
}

/// Samples `app_view` of every capture `pick` chooses until stopped; each state with how often it was seen.
fn watch_app(pick: impl Fn(&str) -> bool + Send + Sync + 'static, new_base: u64) -> (Arc<AtomicBool>, tokio::task::JoinHandle<Vec<(String, usize)>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = tokio::spawn(async move {
        let mut seen: Vec<(String, usize)> = Vec::new();
        while !flag.load(Ordering::Relaxed) {
            let ids: Vec<String> = capture_store::list_captures().into_iter().map(|m| m.id).filter(|id| pick(id)).collect();
            for id in ids {
                let view = app_view(&id, new_base).await;
                match seen.iter_mut().find(|(v, _)| *v == view) {
                    Some((_, n)) => *n += 1,
                    None => seen.push((view, 1)),
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        seen
    });
    (stop, handle)
}

/// Prints what was seen during `label`; the registry never claims rows that aren't there.
async fn report_view(label: &str, watcher: (Arc<AtomicBool>, tokio::task::JoinHandle<Vec<(String, usize)>>)) {
    watcher.0.store(true, Ordering::Relaxed);
    let seen = watcher.1.await.unwrap();
    for (view, n) in &seen {
        println!("[10]   during {label}: {view} ({n} samples)");
    }
    for (view, _) in seen {
        assert!(!view.starts_with("rows < registry"), "{label}: {view}");
    }
}

#[test]
#[ignore]
fn windowed_partial_state_in_the_app() {
    let n: usize = std::env::var("PARTIAL_FRAMES").ok().and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let _dog = watchdog("windowed_partial_state_in_the_app", Duration::from_secs(1200));
    let dir = fresh_dir("partial");
    capture_db::initialise(&dir, false).unwrap();
    let new_base = 1_000_000_000;
    multi_thread(4).block_on(async {
        let src = capture_store::create_session_capture("partial", CaptureKind::Frames, "src".into());
        for chunk in 0..(n / 10_000) as u64 {
            capture_store::append_frames_to_session("partial", batch(chunk * 10_000, 10_000)).await;
        }
        println!("[10] src {src}: {}", app_view(&src, new_base).await);

        let s = src.clone();
        let watcher = watch_app(move |id| id != s, new_base);
        let t = Instant::now();
        let s = src.clone();
        let copy = tokio::task::spawn_blocking(move || capture_store::copy_capture(&s, "copy".into())).await.unwrap().unwrap();
        println!("[10] copy_capture {src} -> {copy} took {:.2?}", t.elapsed());
        report_view("copy_capture", watcher).await;
        println!("[10] copy after: {}", app_view(&copy, new_base).await);

        let s = src.clone();
        let watcher = watch_app(move |id| id == s, new_base);
        let t = Instant::now();
        capture_store::clear_and_refill_capture(&src, batch(new_base, (n / 2) as u64)).await;
        println!("[10] clear_and_refill_capture ({} frames) took {:.2?}", n / 2, t.elapsed());
        report_view("clear_and_refill_capture", watcher).await;
        println!("[10] src after: {}", app_view(&src, new_base).await);

        let c = copy.clone();
        let watcher = watch_app(move |id| id == c, new_base);
        let t = Instant::now();
        let c = copy.clone();
        tokio::task::spawn_blocking(move || capture_store::clear_capture(&c)).await.unwrap().unwrap();
        println!("[10] clear_capture took {:.2?}", t.elapsed());
        report_view("clear_capture", watcher).await;
        println!("[10] copy after: {}", app_view(&copy, new_base).await);
        println!("[10] integrity {}", integrity(&capture_db::current()).await);
        capture_db::current().close().await;
    });
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 11: SIGKILL during a windowed copy, refill or delete
// ============================================================================

const HEAVY_SRC: &str = "heavy_src";
const HEAVY_REFILL: &str = "heavy_refill";
const HEAVY_DEL: &str = "heavy_del";
const HEAVY_DEST: &str = "heavy_dest";
const HEAVY_REFILL_LEN: u64 = 300_000;
const HEAVY_REFILL_BASE: u64 = 1_000_000_000;

#[test]
#[ignore]
fn crash_child_heavy() {
    let (Ok(path), Ok(op)) = (std::env::var("SOAK_CHILD_HEAVY"), std::env::var("SOAK_HEAVY_OP")) else { return };
    current_thread().block_on(async {
        let (store, _) = Store::open(&path).await.unwrap();
        let refill = batch(HEAVY_REFILL_BASE, HEAVY_REFILL_LEN);
        println!("READY");
        let t = Instant::now();
        match op.as_str() {
            "copy" => drop(store.copy_capture_data(HEAVY_SRC, HEAVY_DEST).await.unwrap()),
            "refill" => store.clear_and_refill(HEAVY_REFILL, &refill).await.unwrap(),
            _ => store.delete_capture_data(HEAVY_DEL).await.unwrap(),
        }
        println!("DONE {}", t.elapsed().as_micros());
        std::mem::forget(store);
        tokio::time::sleep(Duration::from_secs(3600)).await;
    });
}

fn spawn_heavy_child(op: &str, path: &Path) -> (std::process::Child, mpsc::Receiver<String>) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["sqlite_soak::crash_child_heavy", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
        .env("SOAK_CHILD_HEAVY", path)
        .env("SOAK_HEAVY_OP", op)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    (child, rx)
}

fn heavy_digest(db: &Path, capture_id: &str) -> (i64, String) {
    table_digest(db, "frames", FRAME_COLS_NO_ROWID, &format!("WHERE capture_id = '{capture_id}'"))
}

const FRAME_COLS_NO_ROWID: &[&str] = &["protocol", "timestamp_us", "frame_id", "bus", "dlc", "payload", "is_extended", "is_fd", "is_rtr", "is_brs", "is_esi", "source_address", "incomplete", "direction", "crc_valid"];

#[test]
#[ignore]
fn crash_kill_mid_heavy_ops() {
    let iterations: usize = std::env::var("CRASH_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
    let per_capture: usize = std::env::var("HEAVY_FRAMES").ok().and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let _dog = watchdog("crash_kill_mid_heavy_ops", Duration::from_secs(3600));
    let dir = fresh_dir("crash-heavy");
    let template = dir.join("template.db");
    let rt = current_thread();
    rt.block_on(async {
        let (store, _) = Store::open(&template).await.unwrap();
        for id in [HEAVY_SRC, HEAVY_REFILL, HEAVY_DEL] {
            resynthesise(&store, id, per_capture).await;
            store
                .save_capture_metadata(&CaptureMetadata {
                    id: id.into(),
                    kind: CaptureKind::Frames,
                    name: id.into(),
                    count: per_capture,
                    start_time_us: None,
                    end_time_us: None,
                    created_at: 1,
                    is_streaming: false,
                    owning_session_id: None,
                    persistent: true,
                    buses: vec![],
                })
                .await
                .unwrap();
        }
        store.close().await;
    });
    let src_digest = heavy_digest(&template, HEAVY_SRC);
    println!("[11] template: {per_capture} frames in each of {HEAVY_SRC}, {HEAVY_REFILL}, {HEAVY_DEL}; db {:?} bytes", file_len(&template));

    let mut rng = Rng::seeded();
    let mut failures = Vec::new();
    for op in ["copy", "refill", "delete"] {
        let calibrate = dir.join(format!("calibrate-{op}.db"));
        copy_writable(&template, &calibrate);
        let (mut child, rx) = spawn_heavy_child(op, &calibrate);
        wait_for_line(&rx, "READY");
        let took_us: u64 = loop {
            let line = rx.recv_timeout(Duration::from_secs(600)).expect("the unkilled op finishes");
            if let Some(us) = line.find("DONE ").map(|at| line[at + 5..].trim().parse().unwrap()) {
                break us;
            }
        };
        child.kill().unwrap();
        child.wait().unwrap();
        for suffix in ["", "-wal", "-shm"] {
            std::fs::remove_file(sidecar(&calibrate, suffix)).ok();
        }
        println!("[11] {op}: unkilled run took {:.2} s", took_us as f64 / 1e6);

        for i in 0..iterations {
            let db = dir.join(format!("{op}{i}.db"));
            copy_writable(&template, &db);
            let (mut child, rx) = spawn_heavy_child(op, &db);
            wait_for_line(&rx, "READY");
            let kill_after = rng.range(0, took_us * 11 / 10);
            std::thread::sleep(Duration::from_micros(kill_after));
            child.kill().unwrap();
            child.wait().unwrap();
            let finished = std::iter::from_fn(|| rx.recv_timeout(Duration::from_millis(100)).ok()).any(|l| l.contains("DONE"));
            let wal_at_kill = file_len(&sidecar(&db, "-wal"));
            let state = rt.block_on(async {
                let (store, _) = Store::open(&db).await.map_err(|e| format!("REOPEN FAILED: {e}"))?;
                let integrity_result = integrity(&store).await;
                let count = |id: &'static str| {
                    let store = store.clone();
                    async move { store.get_frame_count(id).await.unwrap() }
                };
                let at_kill = match op {
                    "copy" => count(HEAVY_DEST).await,
                    "refill" => count(HEAVY_REFILL).await,
                    _ => count(HEAVY_DEL).await,
                };
                let mut checks = vec![("integrity", integrity_result == "ok")];
                let detail = match op {
                    "copy" => {
                        let prefix = sqlite3(&db, &format!(
                            "SELECT COUNT(*) = 0 FROM (SELECT d.timestamp_us AS a, s.timestamp_us AS b, d.payload AS pa, s.payload AS pb FROM
                               (SELECT timestamp_us, payload, ROW_NUMBER() OVER (ORDER BY rowid) AS k FROM frames WHERE capture_id = '{HEAVY_DEST}') d
                               JOIN (SELECT timestamp_us, payload, ROW_NUMBER() OVER (ORDER BY rowid) AS k FROM frames WHERE capture_id = '{HEAVY_SRC}') s USING (k))
                             WHERE a != b OR pa != pb"
                        ));
                        checks.push(("dest is a prefix of src", prefix == "1"));
                        store.sweep_non_persistent().await.unwrap();
                        let after_sweep = count(HEAVY_DEST).await;
                        checks.push(("sweep removes the prefix", after_sweep == 0));
                        format!("dest {at_kill} rows, after sweep {after_sweep}")
                    }
                    "refill" => {
                        store.clear_and_refill(HEAVY_REFILL, &batch(HEAVY_REFILL_BASE, HEAVY_REFILL_LEN)).await.map_err(|e| format!("re-run refill: {e}"))?;
                        let after = count(HEAVY_REFILL).await;
                        let shape = scalar_i64(&store, &format!("SELECT (MIN(timestamp_us) = {HEAVY_REFILL_BASE} AND MAX(timestamp_us) = {HEAVY_REFILL_BASE} + COUNT(*) - 1 AND COUNT(DISTINCT timestamp_us) = COUNT(*)) FROM frames WHERE capture_id = '{HEAVY_REFILL}'")).await;
                        checks.push(("re-run refill completes", after as u64 == HEAVY_REFILL_LEN && shape == 1));
                        format!("refill target {at_kill} rows at reopen, {after} after re-run")
                    }
                    _ => {
                        store.delete_capture_data(HEAVY_DEL).await.map_err(|e| format!("re-run delete: {e}"))?;
                        let after = count(HEAVY_DEL).await;
                        checks.push(("re-run delete completes", after == 0));
                        format!("delete target {at_kill} rows at reopen, {after} after re-run")
                    }
                };
                store.close().await;
                checks.push(("src intact", heavy_digest(&db, HEAVY_SRC) == src_digest));
                checks.push(("integrity after", sqlite3(&db, "PRAGMA integrity_check") == "ok"));
                let failed: Vec<&str> = checks.iter().filter(|(_, ok)| !ok).map(|(c, _)| *c).collect();
                Ok::<_, String>((detail, failed))
            });
            let verdict = match state {
                Err(e) => {
                    failures.push(format!("{op}{i}: {e}"));
                    format!("FAIL {e}")
                }
                Ok((detail, failed)) if failed.is_empty() => format!("{detail} -> ok"),
                Ok((detail, failed)) => {
                    failures.push(format!("{op}{i}: {failed:?}"));
                    format!("{detail} -> FAIL {failed:?}")
                }
            };
            println!("[11] {op} kill {i:>2} after {:>7.1} ms (finished {finished}, -wal {wal_at_kill:?}): {verdict}", kill_after as f64 / 1000.0);
            for suffix in ["", "-wal", "-shm"] {
                std::fs::remove_file(sidecar(&db, suffix)).ok();
            }
        }
    }
    println!("[11] failures: {failures:?}");
    assert!(failures.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

// ============================================================================
// 12: a file stamped newer than this build is refused and left alone
// ============================================================================

fn shasum(p: &Path) -> Option<String> {
    p.exists().then(|| {
        let out = Command::new("shasum").arg("-a").arg("256").arg(p).output().unwrap();
        String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap_or_default().to_string()
    })
}

#[test]
#[ignore]
fn newer_file_is_refused() {
    let dir = fresh_dir("newer");
    let rt = current_thread();
    for (label, prepare) in [("an upgraded copy of the real file, restamped 7", true), ("a fresh store file, restamped 99", false)] {
        let db = dir.join(if prepare { "real.db" } else { "fresh.db" });
        if prepare {
            copy_writable(&pristine(), &db);
        }
        rt.block_on(async { Store::open(&db).await.unwrap().0.close().await });
        let stamp = if prepare { 7 } else { 99 };
        sqlite3(&db, &format!("PRAGMA user_version = {stamp}; PRAGMA wal_checkpoint(TRUNCATE);"));
        let files = |db: &Path| ["", "-wal", "-shm", "-journal"].map(|s| (s, shasum(&sidecar(db, s)), file_len(&sidecar(db, s))));
        let before = files(&db);
        let result = rt.block_on(Store::open(&db));
        let after = files(&db);
        let refused = matches!(result, Err(CaptureError::NewerFile { found, known: 6 }) if found == stamp);
        println!("[12] {label}: Store::open -> {:?}", result.as_ref().map(|_| "opened").map_err(|e| (e.to_string(), format!("{e:?}"))));
        for ((suffix, sha_before, len_before), (_, sha_after, len_after)) in before.iter().zip(&after) {
            println!("[12]   db{suffix}: before {:?} ({len_before:?} bytes), after {:?} ({len_after:?} bytes) -> {}", sha_before.as_deref().map(|s| &s[..16]), sha_after.as_deref().map(|s| &s[..16]), if sha_before == sha_after { "identical" } else { "CHANGED" });
        }
        println!("[12]   user_version after: {}", sqlite3(&db, "PRAGMA user_version"));
        assert!(refused, "not refused with NewerFile");
        assert_eq!(before[0], after[0], "the main file changed");
    }
    let app_dir = dir.join("app");
    std::fs::create_dir_all(&app_dir).unwrap();
    std::fs::copy(dir.join("fresh.db"), app_dir.join("buffers.db")).unwrap();
    println!("[12] capture_db::initialise on a newer file: {:?}", capture_db::initialise(&app_dir, true));
    std::fs::remove_dir_all(&dir).unwrap();
}

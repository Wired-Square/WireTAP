-- The schema the legacy ladder leaves at user_version 6, column for column, so
-- this is a no-op on a file that ladder upgraded.
CREATE TABLE IF NOT EXISTS frames (
    rowid INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    frame_id INTEGER NOT NULL,
    bus INTEGER NOT NULL,
    dlc INTEGER NOT NULL,
    payload BLOB NOT NULL,
    is_extended INTEGER NOT NULL DEFAULT 0,
    is_fd INTEGER NOT NULL DEFAULT 0,
    source_address INTEGER,
    incomplete INTEGER,
    direction TEXT,
    is_rtr INTEGER NOT NULL DEFAULT 0,
    is_brs INTEGER NOT NULL DEFAULT 0,
    is_esi INTEGER NOT NULL DEFAULT 0,
    crc_valid INTEGER
);

CREATE TABLE IF NOT EXISTS bytes (
    rowid INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    byte_val INTEGER NOT NULL,
    timestamp_us INTEGER NOT NULL,
    bus INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS capture_metadata (
    capture_id TEXT PRIMARY KEY,
    capture_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    start_time_us INTEGER,
    end_time_us INTEGER,
    created_at INTEGER NOT NULL,
    owning_session_id TEXT,
    persistent INTEGER NOT NULL DEFAULT 0,
    buses TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS capture_events (
    id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    duration_us INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at_us INTEGER NOT NULL,
    updated_at_us INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frames_capture_ts ON frames (capture_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_frames_capture_fid ON frames (capture_id, frame_id, protocol);
CREATE INDEX IF NOT EXISTS idx_frames_capture_rowid ON frames (capture_id, rowid);
CREATE INDEX IF NOT EXISTS idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_capture_events_capture_ts ON capture_events (capture_id, timestamp_us);

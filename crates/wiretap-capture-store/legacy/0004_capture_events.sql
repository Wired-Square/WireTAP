-- A capture's annotations: a moment or a span, with a note.
CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    duration_us INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at_us INTEGER NOT NULL,
    updated_at_us INTEGER NOT NULL
);
CREATE INDEX idx_capture_events_capture_ts ON capture_events (capture_id, timestamp_us);

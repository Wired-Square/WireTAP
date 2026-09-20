-- Events: user annotations on a capture — a moment (or a span) and a note.
--
-- Rows follow their capture: copied with it, deleted with it, swept with the
-- non-persistent captures on a clear-on-start launch. Attachments will hang
-- off `id` in their own table later, which is why the id is a plain rowid
-- rather than the (capture_id, timestamp_us) pair.
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

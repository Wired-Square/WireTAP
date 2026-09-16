-- Serves the live frame tail's `WHERE capture_id = ? ORDER BY rowid DESC LIMIT n`.
--
-- The v1 indexes cover (capture_id, timestamp_us) and (capture_id, frame_id), neither of
-- which orders by rowid, so SQLite walked every row of the capture into a temporary
-- b-tree to return the last few. Discovery reissues that query on every frame-count
-- signal (twice a second), so the cost grew with the capture for the whole session.
CREATE INDEX IF NOT EXISTS idx_frames_capture_rowid ON frames (capture_id, rowid);

-- Serves WHERE capture_id = ? ORDER BY rowid DESC LIMIT n without a temp b-tree.
CREATE INDEX IF NOT EXISTS idx_frames_capture_rowid ON frames (capture_id, rowid);

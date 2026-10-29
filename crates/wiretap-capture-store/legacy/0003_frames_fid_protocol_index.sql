-- Replaces the frame-id index with one carrying protocol, so the filtered COUNT stays covering.
DROP INDEX IF EXISTS idx_frames_capture_fid;
CREATE INDEX idx_frames_capture_fid ON frames (capture_id, frame_id, protocol);

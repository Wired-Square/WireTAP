-- Widens the frame-id index to carry `protocol`, so the filtered COUNT stays covering.
--
-- Frame identity is (protocol, frame_id) — CAN 0x100 and Modbus register 256 are
-- different frames that share a numeric id. The filtered reads now say
-- `(protocol, frame_id) IN (VALUES …)`, and protocol was in no index, so SQLite had to
-- fetch each candidate row to test it. The two COUNT(*) queries were the only users of
-- the v1 (capture_id, frame_id) index and the only ones it covered; one of them is on
-- the live tail path Discovery reissues twice a second.
--
-- Replacing the index rather than adding one keeps the write path at three frame
-- indexes, so a 5 kfps capture pays only the wider key, not another b-tree.
DROP INDEX IF EXISTS idx_frames_capture_fid;
CREATE INDEX idx_frames_capture_fid ON frames (capture_id, frame_id, protocol);

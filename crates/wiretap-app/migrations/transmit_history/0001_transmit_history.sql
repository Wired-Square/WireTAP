-- IF NOT EXISTS: a file written before the chain already has the table and its indexes.
CREATE TABLE IF NOT EXISTS transmit_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT    NOT NULL,
    timestamp_us INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    frame_id     INTEGER,
    dlc          INTEGER,
    bytes        BLOB    NOT NULL,
    bus          INTEGER NOT NULL DEFAULT 0,
    is_extended  INTEGER NOT NULL DEFAULT 0,
    is_fd        INTEGER NOT NULL DEFAULT 0,
    success      INTEGER NOT NULL DEFAULT 1,
    error_msg    TEXT
);

CREATE INDEX IF NOT EXISTS idx_transmit_history_id ON transmit_history(id DESC);
CREATE INDEX IF NOT EXISTS idx_transmit_history_ts ON transmit_history(timestamp_us);
CREATE INDEX IF NOT EXISTS idx_transmit_history_session ON transmit_history(session_id, id DESC);

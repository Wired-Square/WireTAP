#!/usr/bin/env python3
"""
SocketCAN to TCP GVRET bridge server for WireTAP.

This server bridges SocketCAN interfaces to TCP clients using the GVRET protocol,
enabling remote CAN bus access from WireTAP or other GVRET-compatible tools.
Optionally ingests frames to PostgreSQL for logging and analysis.
"""

import argparse
import logging
import os
import select
import signal
import socket
import sqlite3
import struct
import tomllib
import time
import threading
import sys
from datetime import datetime, timezone
from pathlib import Path
from queue import Queue, Full, Empty
from typing import Dict, List, Optional, Tuple

from pyroute2 import IPRoute

log = logging.getLogger("wiretap")

# SocketCAN ID flags/masks
CAN_EFF_FLAG = 0x80000000
CAN_RTR_FLAG = 0x40000000
CAN_ERR_FLAG = 0x20000000
CAN_EFF_MASK = 0x1FFFFFFF
CAN_SFF_MASK = 0x000007FF

# Socket timestamp constant (not in Python's socket module on all platforms)
SO_TIMESTAMP = getattr(socket, 'SO_TIMESTAMP', 29)  # 29 on Linux

# CAN FD constants
SOL_CAN_RAW = 101           # from linux/can/raw.h
CAN_RAW_FD_FRAMES = 5       # enable CAN FD frames
CANFD_BRS = 0x01            # Bit Rate Switch flag
CANFD_ESI = 0x02            # Error State Indicator flag

# CAN FD DLC to length mapping (DLC 9-15 map to 12,16,20,24,32,48,64)
CAN_FD_DLC_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]

def dlc_to_len(dlc: int, is_fd: bool = False) -> int:
    """Convert DLC to actual data length."""
    if dlc <= 8:
        return dlc
    if is_fd and dlc <= 15:
        return CAN_FD_DLC_LEN[dlc]
    return 8  # Classic CAN max

def len_to_dlc(length: int) -> int:
    """Convert data length to DLC (for CAN FD, finds minimum DLC that fits)."""
    if length <= 8:
        return length
    for dlc, dlen in enumerate(CAN_FD_DLC_LEN):
        if dlen >= length:
            return dlc
    return 15  # Max DLC for 64 bytes

# Interface Line Attributes - Type Length Value (from linux/uapi/can/netlink.h)
IFLA_CAN_BITTIMING       = 1
IFLA_CAN_DATA_BITTIMING  = 9


def _colour_red(s: str, enable: bool) -> str:
    return f"\x1b[31m{s}\x1b[0m" if enable else s

def _colour_yellow(s: str, enable: bool) -> str:
    return f"\x1b[33m{s}\x1b[0m" if enable else s

def detect_bitrates(iface="can0", default=500000):
    """Detect nominal and data bitrates for a CAN interface via netlink."""
    ipr = IPRoute()
    try:
        idx = ipr.link_lookup(ifname=iface)[0]
        msg = ipr.get_links(idx)[0]
        linkinfo = dict(msg["attrs"])["IFLA_LINKINFO"]
        attrs = dict(linkinfo["attrs"])
        raw = attrs.get("IFLA_INFO_DATA")

        if not raw:
            return default, 0

        # Convert colon-hex string to bytes if needed
        if isinstance(raw, (bytes, bytearray, memoryview)):
            raw_bytes = bytes(raw)
        elif isinstance(raw, str):
            raw_bytes = bytes(int(x, 16) for x in raw.split(':'))
        else:
            raw_bytes = bytes(raw)   # fallback

        tlvs = _parse_tlvs(raw_bytes)

        nominal = default
        data = 0
        for t, v in tlvs:
            if t in (IFLA_CAN_BITTIMING, IFLA_CAN_DATA_BITTIMING) and len(v) >= 4:
                br, = struct.unpack_from("<I", v, 0)
                if t == IFLA_CAN_BITTIMING:
                    nominal = br
                else:
                    data = br
        return nominal, data
    except Exception:
        return default, 0
    finally:
        ipr.close()

def _parse_tlvs(raw: bytes):
    """Parse a netlink attr stream into [(type, value_bytes), ...]."""
    out, i = [], 0
    align4 = lambda x: (x + 3) & ~3
    while i + 4 <= len(raw):
        alen, atype = struct.unpack_from("HH", raw, i)
        if alen < 4 or i + alen > len(raw):
            break
        val = raw[i+4:i+alen]
        out.append((atype, val))
        i += align4(alen)
    return out

def format_candump_line(
    frame_bytes: bytes,
    color_ascii: bool = False,
    t0_us: int = 0,
    bus_idx: int | None = None,
    is_fd: bool = False
) -> str:
    """
    Pretty text line:
      (<ts>) <ID> <S|E><F><flags> [<dlc>] <b0 .. bN>  | <ASCII>
    - ID: 3 hex (std 11-bit) or 8 hex (ext 29-bit)
    - F: present for CAN FD frames
    - flags: R for RTR, ! for error, B for BRS, E for ESI
    - bytes padded; ASCII shows printable chars, '.' otherwise
    - If color_ascii=True, printable bytes (0x20..0x7E) are colored red in both columns.
    """
    # Support both classic (16 bytes) and FD (72 bytes) frames
    if len(frame_bytes) == 16:
        can_id, dlc = struct.unpack_from("<IB", frame_bytes, 0)
        fd_flags = 0
        raw = frame_bytes[8:16]
        data_len = min(dlc, 8)
        is_fd = False
    elif len(frame_bytes) == 72:
        can_id, dlc, fd_flags = struct.unpack_from("<IBB", frame_bytes, 0)
        raw = frame_bytes[8:72]
        data_len = dlc_to_len(dlc, is_fd=True)
        is_fd = True
    else:
        return ""

    data = raw[:data_len]

    is_ext = bool(can_id & CAN_EFF_FLAG)
    is_rtr = bool(can_id & CAN_RTR_FLAG)
    is_err = bool(can_id & CAN_ERR_FLAG)

    arb_id = can_id & (CAN_EFF_MASK if is_ext else CAN_SFF_MASK)
    id_str = f"{arb_id:08X}" if is_ext else f"{arb_id:03X}"
    kind = "E" if is_ext else "S"
    if is_fd:
        kind += "F"  # Mark as FD frame
    flags = ""
    if is_rtr:
        flags += "R"
    if is_err:
        flags += "!"
    if is_fd and (fd_flags & CANFD_BRS):
        flags += "B"  # Bit Rate Switch
    if is_fd and (fd_flags & CANFD_ESI):
        flags += "E"  # Error State Indicator

    # hex bytes with optional red for printable ASCII
    hex_parts = []
    ascii_parts = []

    for b in data:
        is_print = 0x20 <= b <= 0x7E
        hx = f"{b:02X}"
        ch = chr(b) if is_print else "."
        hex_parts.append(_colour_red(hx, color_ascii and is_print))
        ascii_parts.append(_colour_red(ch, color_ascii and is_print))

    # Pad hex output: 8 bytes for classic (23 chars), variable for FD
    hex_pad = 23 if not is_fd else (data_len * 3 - 1)
    bytes_str = " ".join(hex_parts).ljust(hex_pad)
    ascii_str = "".join(ascii_parts)

    # Bus tag (e.g., B0). Highlight in yellow if colour is enabled.
    bus_tag = ""
    if bus_idx is not None:
        bus_tag = _colour_yellow(f"B{bus_idx} ", color_ascii)

    # Timestamp: relative if t0_us provided, otherwise absolute
    if t0_us:
        now_us = time.monotonic_ns() // 1_000
        rel_us = now_us - t0_us
        sec, rem_us = divmod(rel_us, 1_000_000)
        ms, us = divmod(rem_us, 1_000)
        ts_str = f"{sec}.{ms:03d}_{us:03d}"
    else:
        ts_str = f"{time.time():.6f}"

    return f"{bus_tag}({ts_str}) {id_str} {kind}{flags} [{dlc}] {bytes_str} | {ascii_str}\n"


class DiskCache:
    """
    SQLite-based disk cache for CAN frames when PostgreSQL is unavailable.
    Stores frames in a single table, supports batch operations.
    """
    DEFAULT_PATH = Path.home() / ".wiretap-server-cache.db"

    def __init__(self, path: Optional[str] = None, max_mb: int = 1000):
        self.path = Path(path) if path else self.DEFAULT_PATH
        self.max_bytes = max_mb * 1024 * 1024
        self._log = log.getChild("cache")
        self._conn: sqlite3.Connection = self._init_db()
        self._closed = False

    def _init_db(self) -> sqlite3.Connection:
        """Initialise database and create table if needed."""
        conn = sqlite3.connect(str(self.path), check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS frames (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                extended INTEGER NOT NULL,
                is_fd INTEGER NOT NULL,
                arb_id INTEGER NOT NULL,
                dlc INTEGER NOT NULL,
                data BLOB NOT NULL,
                bus INTEGER NOT NULL,
                dir TEXT NOT NULL
            )
        """)
        conn.commit()
        return conn

    def write_batch(self, rows: List[tuple]) -> int:
        """
        Write a batch of frame rows to cache.
        Each row: (ts_dt, extended, is_fd, arb_id, id_hex, dlc, data, bus, dir)
        Returns number of rows written.
        """
        if not rows:
            return 0

        # Convert datetime to float timestamp for storage
        converted = []
        for row in rows:
            ts_dt, extended, is_fd, arb_id, _id_hex, dlc, data, bus, dir_ = row
            ts_float = ts_dt.timestamp() if hasattr(ts_dt, 'timestamp') else float(ts_dt)
            converted.append((ts_float, int(extended), int(is_fd), arb_id, dlc, data, bus, dir_))

        self._conn.executemany(
            "INSERT INTO frames (ts, extended, is_fd, arb_id, dlc, data, bus, dir) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            converted
        )
        self._conn.commit()
        return len(converted)

    def read_batch(self, limit: int = 500) -> Tuple[List[int], List[tuple]]:
        """
        Read a batch of frames from cache (oldest first).
        Returns (ids, rows) where rows match PostgresWriter format:
        (ts_dt, extended, is_fd, arb_id, id_hex, dlc, data, bus, dir)
        """
        cur = self._conn.execute(
            "SELECT id, ts, extended, is_fd, arb_id, dlc, data, bus, dir "
            "FROM frames ORDER BY id LIMIT ?",
            (limit,)
        )
        ids = []
        rows = []
        for row in cur.fetchall():
            id_, ts, extended, is_fd, arb_id, dlc, data, bus, dir_ = row
            ts_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            ids.append(id_)
            rows.append((ts_dt, bool(extended), bool(is_fd), arb_id, None, dlc, data, bus, dir_))
        return ids, rows

    def delete_batch(self, ids: List[int]):
        """Delete frames by ID after successful write to PostgreSQL."""
        if not ids:
            return
        placeholders = ",".join("?" * len(ids))
        self._conn.execute(f"DELETE FROM frames WHERE id IN ({placeholders})", ids)
        self._conn.commit()

    def count(self) -> int:
        """Return number of cached frames."""
        cur = self._conn.execute("SELECT COUNT(*) FROM frames")
        return cur.fetchone()[0]

    def is_empty(self) -> bool:
        """Check if cache has no frames."""
        cur = self._conn.execute("SELECT 1 FROM frames LIMIT 1")
        return cur.fetchone() is None

    def size_bytes(self) -> int:
        """Return approximate size of cache file in bytes."""
        try:
            return self.path.stat().st_size
        except OSError:
            return 0

    def is_full(self) -> bool:
        """Check if cache has exceeded max size."""
        return self.size_bytes() >= self.max_bytes

    def clear(self):
        """Delete all cached frames and vacuum."""
        self._conn.execute("DELETE FROM frames")
        self._conn.execute("VACUUM")
        self._conn.commit()

    def close(self):
        """Close database connection."""
        if not self._closed:
            self._conn.close()
            self._closed = True

    def delete_file(self):
        """Delete cache file (call after close)."""
        try:
            self.path.unlink(missing_ok=True)
            # Also remove WAL and SHM files
            Path(str(self.path) + "-wal").unlink(missing_ok=True)
            Path(str(self.path) + "-shm").unlink(missing_ok=True)
        except OSError:
            pass


class PostgresWriter:
    """
    Background batcher calling your import function.
    Logs queue health, drops, write counts, and connection state.
    """
    def __init__(
        self,
        dsn: str,
        ingest_func: str = "public.ingest_can_frame",
        batch_size: int = 500,
        flush_interval: float = 0.5,
        queue_max: int = 50000,
        default_dir: str = "rx",
        stats_interval: float = 10.0,
        cache_path: Optional[str] = None,
        cache_max_mb: int = 1000,
        queue_flush_pct: int = 50,
    ):
        if not dsn:
            raise ValueError("Postgres DSN is required")

        self.dsn = dsn
        self.func = ingest_func
        self.batch_size = int(batch_size)
        self.flush_interval = float(flush_interval)
        self.default_dir = default_dir
        self.q: "Queue[tuple]" = Queue(maxsize=int(queue_max))
        self._alive = True
        self._log = log.getChild("pg")

        # --- disk cache for resilience ---
        self._disk_cache = DiskCache(path=cache_path, max_mb=cache_max_mb)
        self._db_unavailable = False
        self._draining_cache = False
        self._queue_flush_threshold = queue_flush_pct / 100.0

        # Check for existing cached frames from previous session
        cached_count = self._disk_cache.count()
        if cached_count > 0:
            self._log.warning(
                "Found %d cached frames from previous session, will drain on connect",
                cached_count
            )

        # --- metrics ---
        self.count_enqueued = 0
        self.count_written = 0
        self.count_dropped = 0
        self.count_cached = 0
        self.count_cache_recovered = 0
        self._last_full_log = 0.0
        self._last_bucket = -1  # -1, 80, 95, 100
        self._t0 = time.time()

        # start worker
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

        # periodic stats (optional)
        self.stats_interval = float(stats_interval)
        if self.stats_interval > 0:
            self._stats_thread = threading.Thread(target=self._stats_loop, daemon=True)
            self._stats_thread.start()

    def enqueue(self, ts: float, can_id: int, dlc: int, data: bytes, bus: int,
                dir_: Optional[str] = None, is_fd: bool = False):
        """Queue a CAN frame for batch insertion to PostgreSQL."""
        extended = bool(can_id & CAN_EFF_FLAG)
        arb_id = can_id & (CAN_EFF_MASK if extended else CAN_SFF_MASK)
        # For FD frames, use DLC mapping; for classic, cap at 8
        data_len = dlc_to_len(dlc, is_fd) if is_fd else min(dlc, 8)
        payload = bytes(data[:data_len])
        dir_final = dir_ or self.default_dir
        ts_dt = datetime.fromtimestamp(ts, tz=timezone.utc)

        row = (
            ts_dt,          # _ts
            extended,       # _extended
            is_fd,          # _is_fd
            arb_id,         # _id
            None,           # _id_hex
            dlc,            # _dlc
            payload,        # _data_bytes
            int(bus),       # _bus
            dir_final,      # _dir
        )

        try:
            self.q.put_nowait(row)
            self.count_enqueued += 1
            self._maybe_warn_thresholds()
        except Full:
            self.count_dropped += 1
            self._log_queue_full()

    def close(self):
        """Shut down the writer, flushing remaining frames to DB or disk cache."""
        self._alive = False
        try:
            self.q.put_nowait(())  # wake worker
        except Exception:
            pass
        self._thread.join(timeout=5.0)  # Give more time for shutdown flush

        # If worker didn't flush (hung or timed out), emergency flush queue to disk
        if not self.q.empty():
            self._emergency_flush_to_disk()

        # Worker handles final flush via _shutdown_flush()
        if self.stats_interval > 0:
            # no need to join stats thread strictly; it's daemon
            pass

        # Ensure disk cache is closed
        if not self._disk_cache._closed:
            self._disk_cache.close()

        # Log final stats
        cache_count = self._disk_cache.count() if not self._disk_cache._closed else 0
        self._log.info("closed: wrote=%d cached=%d recovered=%d dropped=%d pending_in_cache=%d",
                      self.count_written, self.count_cached, self.count_cache_recovered,
                      self.count_dropped, cache_count)

    # -------- internals --------
    def _connect(self):
        import psycopg2
        from psycopg2.extras import execute_values
        self._psycopg2 = psycopg2
        self._execute_values = execute_values
        self._conn = psycopg2.connect(self.dsn, application_name="wiretap-server")
        self._conn.autocommit = False
        self._cur = self._conn.cursor()
        # Set statement timeout so blocked writes fail fast and trigger disk cache fallback
        # 10 seconds should be generous for normal batch inserts
        self._cur.execute("SET statement_timeout = '10s'")
        # Use execute_values for batch inserts - much faster than executemany
        # Template matches the row tuple order from enqueue()
        self._sql = (
            f"SELECT {self.func}(v._ts, v._extended, v._is_fd, v._id, v._id_hex, "
            "v._dlc, v._data_bytes, v._bus, v._dir) FROM (VALUES %s) "
            "AS v(_ts, _extended, _is_fd, _id, _id_hex, _dlc, _data_bytes, _bus, _dir)"
        )
        self._template = (
            "(%s::timestamptz, %s::boolean, %s::boolean, %s::integer, %s::text, "
            "%s::smallint, %s::bytea, %s::integer, %s::text)"
        )
        self._log.info("connected")

    def _close_conn(self):
        try:
            self._cur.close()
        except Exception:
            pass
        try:
            self._conn.close()
        except Exception:
            pass
        self._cur = self._conn = None

    def _worker(self):
        backoff = 0.5
        batch: List[tuple] = []
        while self._alive:
            try:
                # Proactively flush queue to disk if it's getting full
                self._maybe_flush_queue_overflow()

                # Try to connect if not connected
                if not getattr(self, "_conn", None):
                    self._connect()
                    backoff = 0.5
                    if self._db_unavailable:
                        self._db_unavailable = False
                        self._log.info("database connection restored")

                # Priority 1: Drain disk cache first (strict temporal ordering)
                cache_empty = self._disk_cache.is_empty()
                self._log.debug(
                    "cache check: is_empty=%s, _draining_cache=%s",
                    cache_empty, self._draining_cache
                )
                if not cache_empty:
                    if not self._draining_cache:
                        self._draining_cache = True
                        self._log.info(
                            "draining %d cached frames to database",
                            self._disk_cache.count()
                        )

                    ids, batch = self._disk_cache.read_batch(self.batch_size)
                    self._log.debug("read_batch returned %d ids, %d rows", len(ids), len(batch))
                    if batch:
                        self._log.debug("executing batch insert for %d cached frames", len(batch))
                        self._execute_values(self._cur, self._sql, batch, template=self._template)
                        self._conn.commit()
                        self._disk_cache.delete_batch(ids)
                        self.count_written += len(batch)
                        self.count_cache_recovered += len(batch)
                        self._log.debug(
                            "batch committed, cache_recovered=%d",
                            self.count_cache_recovered
                        )
                        continue  # Keep draining cache

                    # Cache is now empty
                    self._draining_cache = False
                    self._log.info("cache drain complete, deleting cache file")
                    self._disk_cache.close()
                    self._disk_cache.delete_file()
                    # Reinitialise for future use
                    self._disk_cache = DiskCache(
                        path=str(self._disk_cache.path),
                        max_mb=self._disk_cache.max_bytes // (1024 * 1024)
                    )

                # Priority 2: Process in-memory queue
                batch = []
                try:
                    item = self.q.get(timeout=self.flush_interval)
                    if item and len(item) == 9:
                        batch.append(item)
                except Empty:
                    pass

                while len(batch) < self.batch_size:
                    try:
                        item = self.q.get_nowait()
                    except Empty:
                        break
                    if item and len(item) == 9:
                        batch.append(item)

                if not batch:
                    self._conn.commit()  # keep xact fresh
                    continue

                self._execute_values(self._cur, self._sql, batch, template=self._template)
                self._conn.commit()
                self.count_written += len(batch)

            except Exception as e:
                self._log.error("write error: %s", e)
                self._close_conn()

                # DB unavailable - cache the batch to disk instead of losing it
                if not self._db_unavailable:
                    self._db_unavailable = True
                    self._log.warning("database unavailable, caching frames to disk")

                # Write any pending batch to disk cache
                if batch:
                    self._write_to_cache(batch)
                    batch = []

                # Drain in-memory queue to disk to prevent overflow
                self._drain_queue_to_cache()

                time.sleep(backoff)
                backoff = min(backoff * 2.0, 10.0)

        # on shutdown, try to flush remaining
        self._shutdown_flush()

    def _write_to_cache(self, batch: List[tuple]):
        """Write a batch to disk cache, respecting size limit."""
        if self._disk_cache.is_full():
            self._log.error("disk cache full (%d MB), dropping %d frames",
                           self._disk_cache.max_bytes // (1024 * 1024), len(batch))
            self.count_dropped += len(batch)
            return

        try:
            written = self._disk_cache.write_batch(batch)
            self.count_cached += written
        except Exception as e:
            self._log.error("disk cache write error: %s", e)
            self.count_dropped += len(batch)

    def _drain_queue_to_cache(self):
        """Drain in-memory queue to disk cache while DB is unavailable."""
        drained = 0
        batch = []
        while True:
            try:
                item = self.q.get_nowait()
            except Empty:
                break
            if item and len(item) == 9:
                batch.append(item)
                if len(batch) >= self.batch_size:
                    self._write_to_cache(batch)
                    drained += len(batch)
                    batch = []

        if batch:
            self._write_to_cache(batch)
            drained += len(batch)

        if drained > 0:
            self._log.info("drained %d frames from queue to disk cache", drained)

    def _maybe_flush_queue_overflow(self):
        """Flush queue to disk if it exceeds threshold, even when DB is available."""
        cap = self.q.maxsize or 0
        if not cap:
            return

        size = self.q.qsize()
        if size / cap >= self._queue_flush_threshold:
            self._log.warning(
                "queue at %d%% (%d/%d), flushing to disk cache",
                int(size / cap * 100), size, cap
            )
            self._drain_queue_to_cache()

    def _shutdown_flush(self):
        """Flush remaining frames on shutdown - to DB if available, else to disk."""
        remaining = []
        while True:
            try:
                item = self.q.get_nowait()
            except Empty:
                break
            if item and len(item) == 9:
                remaining.append(item)

        if not remaining:
            self._close_conn()
            return

        # Try PostgreSQL first
        if getattr(self, "_conn", None):
            try:
                self._execute_values(self._cur, self._sql, remaining, template=self._template)
                self._conn.commit()
                self.count_written += len(remaining)
                self._log.info("shutdown: flushed %d frames to database", len(remaining))
                self._close_conn()
                return
            except Exception as e:
                self._log.error("shutdown flush to DB failed: %s", e)
                self._close_conn()

        # Fall back to disk cache
        self._write_to_cache(remaining)
        self._log.info("shutdown: flushed %d frames to disk cache", len(remaining))
        self._disk_cache.close()

    def _emergency_flush_to_disk(self):
        """Emergency flush of in-memory queue to disk when worker is hung."""
        count = 0
        batch = []
        while True:
            try:
                item = self.q.get_nowait()
            except Empty:
                break
            if item and len(item) == 9:
                batch.append(item)
                if len(batch) >= self.batch_size:
                    self._write_to_cache(batch)
                    count += len(batch)
                    batch = []

        if batch:
            self._write_to_cache(batch)
            count += len(batch)

        if count > 0:
            self._log.warning("emergency flush: saved %d queued frames to disk cache", count)

    def _stats_loop(self):
        while self._alive:
            time.sleep(self.stats_interval)
            try:
                size = self.q.qsize()
                cap = self.q.maxsize or 0
                occ = (size / cap * 100.0) if cap else 0.0
                cache_count = self._disk_cache.count() if not self._disk_cache._closed else 0

                # Build stats message
                conn_status = 'up' if getattr(self, '_conn', None) else 'down'
                msg = (
                    f"stats queued={size}/{cap} ({occ:.0f}%) "
                    f"enq={self.count_enqueued} wrote={self.count_written} "
                    f"dropped={self.count_dropped} conn={conn_status}"
                )
                if cache_count > 0 or self.count_cached > 0:
                    msg += (
                        f" cached={self.count_cached} "
                        f"cache_recovered={self.count_cache_recovered} "
                        f"cache_pending={cache_count}"
                    )
                self._log.info(msg)
            except Exception:
                pass

    def _bucket_for_ratio(self, ratio):
        # return threshold bucket 80 / 95 / 100 or -1
        if ratio >= 1.0:
            return 100
        if ratio >= 0.95:
            return 95
        if ratio >= 0.80:
            return 80
        return -1

    def _maybe_warn_thresholds(self):
        cap = self.q.maxsize or 0
        if not cap:
            return
        size = self.q.qsize()
        ratio = size / cap
        bucket = self._bucket_for_ratio(ratio)
        if bucket not in (-1, self._last_bucket):
            self._last_bucket = bucket
            self._log.warning("queue high water mark: %d%% (size=%d cap=%d)", bucket, size, cap)
        elif bucket == -1 and self._last_bucket != -1:
            # dropped back below 80%
            self._last_bucket = -1
            self._log.info("queue recovered: size=%d cap=%d", size, cap)

    def _log_queue_full(self):
        now = time.time()
        if now - self._last_full_log >= 5.0:  # rate-limit spam
            size = self.q.qsize()
            cap = self.q.maxsize or 0
            self._log.error(
                "queue FULL: size=%d cap=%d dropped_total=%d",
                size, cap, self.count_dropped
            )
            self._last_full_log = now


class GVRETClient:
    """
    https://github.com/collin80/M2RET/blob/master/CommProtocol.txt

    GVRET opcodes handled here:
      F1 00 : BUILD_CAN_FRAME (host → device)
      F1 01 : TIMEBASE
      F1 06 : GET_CANBUS_PARAMS
      F1 07 : GET_DEV_INFO
      F1 09 : KEEPALIVE
      F1 0C : GET_NUMBUSES
    """
    def __init__(
        self, conn: socket.socket, bus_count: int, bus_speeds: Tuple[int, ...],
        tx_func=None
    ):
        self.conn = conn
        self.addr = conn.getpeername()
        self.binary = False
        self.buf = bytearray()
        self.alive = True
        self.lock = threading.Lock()
        self.bus_count = bus_count
        self.bus_speeds = bus_speeds
        self.t0 = time.monotonic()
        self.tx_func = tx_func
        self.thread = threading.Thread(target=self._rx_loop, daemon=True)
        self.thread.start()


    def _send(self, b: bytes):
        with self.lock:
            try:
                self.conn.sendall(b)
            except Exception:
                self.close()

    def reply_dev_info(self):
        """Send GVRET device info response (F1 07)."""
        build = 400
        eeprom_ver = 1
        file_type = 0
        auto_start = 0
        singlewire = 0
        payload = (
            build.to_bytes(2, "little")
            + bytes([eeprom_ver, file_type, auto_start, singlewire])
        )
        self._send(b"\xF1\x07" + payload)

    def reply_canbus_params(self):
        """Send GVRET CAN bus parameters response (F1 06)."""
        # Advertise up to two buses in this legacy field (extra buses are still
        # visible via F1 0C bus count; many tools handle >2 via other queries).
        n = self.bus_count
        can0_enabled = 1 if n >= 1 else 0
        can1_enabled = 1 if n >= 2 else 0
        can0_listen = 0
        can1_listen = 0

        can0_flags = (1 if can0_enabled else 0) | ((1 if can0_listen else 0) << 4)
        can1_flags = (1 if can1_enabled else 0) | ((1 if can1_listen else 0) << 4)

        can0_speed = self.bus_speeds[0] if n >= 1 else 0
        can1_speed = self.bus_speeds[1] if n >= 2 else 0

        payload = bytes([can0_flags]) \
                + int(can0_speed).to_bytes(4, "little", signed=False) \
                + bytes([can1_flags]) \
                + int(can1_speed).to_bytes(4, "little", signed=False)

        self._send(b"\xF1\x06" + payload)

    def reply_num_buses(self):
        """Send GVRET bus count response (F1 0C)."""
        self._send(b"\xF1\x0C" + bytes([self.bus_count & 0xFF]))

    def reply_timebase(self):
        """Send GVRET timebase response (F1 01)."""
        us = int((time.monotonic() - self.t0) * 1_000_000) & 0xFFFFFFFF
        self._send(b"\xF1\x01" + us.to_bytes(4, "little"))

    def reply_keepalive(self):
        """Send GVRET keepalive response (F1 09)."""
        self._send(b"\xF1\x09\xDE\xAD")

    def _rx_loop(self):
        try:
            self.conn.settimeout(0.1)
            while self.alive:
                try:
                    chunk = self.conn.recv(4096)
                    if not chunk:
                        break
                    self.buf.extend(chunk)

                    # handshake: E7 E7 → enter binary mode
                    while True:
                        idx = self.buf.find(b"\xE7\xE7")
                        if idx == -1:
                            break
                        del self.buf[:idx + 2]
                        if not self.binary:
                            self.binary = True

                    # parse binary commands
                    while self.binary:
                        # Resync: drop non-F1 leading bytes in binary mode
                        while self.binary and self.buf and self.buf[0] != 0xF1:
                            del self.buf[0]
                        if len(self.buf) < 2:
                            break
                        if len(self.buf) < 2 or self.buf[0] != 0xF1:
                            break

                        # parse F1 <cmd> requests
                        cmd = self.buf[1]

                        if cmd == 0x00:
                            # SEND FRAME: variable length; only consume if complete
                            if not self._try_consume_send_frame():
                                break  # wait for more bytes
                            # continue loop (may be more commands queued)
                            continue

                        # Fixed-size / no-payload commands: consume header now
                        # For these we only need the 2-byte header to reply.
                        if len(self.buf) < 2:
                            break

                        del self.buf[:2]

                        if   cmd == 0x07:
                            self.reply_dev_info()
                        elif cmd == 0x06:
                            self.reply_canbus_params()
                        elif cmd == 0x0C:
                            self.reply_num_buses()
                        elif cmd == 0x01:
                            self.reply_timebase()
                        elif cmd == 0x09:
                            self.reply_keepalive()
                        else:
                            # Unknown/unsupported: ignore
                            pass

                except socket.timeout:
                    pass
        finally:
            self.close()

    def _try_consume_send_frame(self) -> bool:
        """
        Try to parse: F1 00 <ID:4 LE> <bus:1> <len:1> <data:len>
        Returns True if a full frame was consumed and sent; False if not enough bytes yet.
        """
        # Minimum header: F1 00 + 4 (id) + 1 (bus) + 1 (len) = 8 bytes
        if len(self.buf) < 8:
            return False
        if not (self.buf[0] == 0xF1 and self.buf[1] == 0x00):
            return False
        # Peek length to know how many data bytes we need
        # Layout offsets relative to start:
        # 2..5 id, 6 bus, 7 dlc, 8..(8+dlc-1) data
        dlc = self.buf[7]
        need = 8 + dlc
        if len(self.buf) < need:
            return False

        # Parse fields
        can_id_le = int.from_bytes(self.buf[2:6], "little", signed=False)
        bus = self.buf[6] & 0xFF
        dlc = min(dlc, 8)
        data = bytes(self.buf[8:8+dlc])

        # Drop this command from buffer
        del self.buf[:need]

        # GVRET uses bit31 to indicate extended IDs for RX; apply same for TX:
        # If bit31 set in incoming ID, set CAN_EFF_FLAG on socketcan id.
        is_eff = bool(can_id_le & 0x80000000)
        arb = can_id_le & (0x1FFFFFFF if is_eff else 0x7FF)
        can_id_sc = arb | (CAN_EFF_FLAG if is_eff else 0)

        # (RTR/ERR not specified in this command; can be added later if needed)

        if callable(self.tx_func):
            self.tx_func(bus, can_id_sc, data)
        return True

    def send_frame(self, can_id: int, bus: int, data: bytes, is_fd: bool = False):
        """Send a CAN frame to the client in GVRET binary format."""
        if not self.binary:
            return

        data_len = len(data)
        if is_fd:
            # CAN FD: DLC can represent up to 64 bytes
            data_len = min(data_len, 64)
            dlc = len_to_dlc(data_len)
        else:
            # Classic CAN: max 8 bytes
            data_len = min(data_len, 8)
            dlc = data_len

        # Build ID with extended flag (GVRET wants bit31 set for EFF)
        is_eff = bool(can_id & CAN_EFF_FLAG)
        arb_id = can_id & (CAN_EFF_MASK if is_eff else CAN_SFF_MASK)
        gvret_id = arb_id | (0x80000000 if is_eff else 0)

        # Timestamp (µs since start) — simple wall time is fine
        ts_us = int((time.monotonic() - self.t0) * 1_000_000) & 0xFFFFFFFF

        # Byte10 packs bus in upper nibble, DLC in lower nibble
        # For FD frames with DLC > 15, we use the actual data length instead
        bus_and_dlc = ((bus & 0x0F) << 4) | (dlc & 0x0F)

        payload = bytearray()
        payload += b"\xF1\x00"
        payload += ts_us.to_bytes(4, "little", signed=False)
        payload += gvret_id.to_bytes(4, "little", signed=False)
        payload.append(bus_and_dlc)
        payload += data[:data_len]
        payload.append(0x00)

        self._send(payload)

    def close(self):
        """Close the client connection."""
        if not self.alive:
            return
        self.alive = False
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.conn.close()
        except Exception:
            pass


class CanTcpServer:
    """
    Encapsulates:
      - SocketCAN reader (classic CAN or CAN FD)
      - TCP server socket
      - GVRET client registry
      - Optional Postgres writer
    """
    def __init__(self, iface="can0", host="0.0.0.0", port=23, bus_offset=0,
                 echo_console=False, pg_writer: Optional[PostgresWriter]=None,
                 default_dir="rx", can_fd: bool = False):
        ifaces = [x.strip() for x in str(iface).split(",") if x.strip()]
        if not ifaces:
            raise ValueError("No CAN interfaces provided")

        self.ifaces = ifaces
        self.host = host
        self.port = port
        self.bus_offset = int(bus_offset)
        self.echo_console = echo_console
        self.colour = False
        self.t0_us = time.monotonic_ns() // 1000
        self.pg_writer = pg_writer
        self.default_dir = default_dir
        self.can_fd = can_fd
        # Frame size: 72 bytes for FD, 16 bytes for classic
        self.frame_size = 72 if can_fd else 16

        # Open one CAN raw socket per iface with kernel timestamps enabled
        self.can_socks: list[socket.socket] = []
        for ifn in self.ifaces:
            try:
                s = socket.socket(socket.PF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
                s.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMP, 1)
                if can_fd:
                    s.setsockopt(SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
                s.bind((ifn,))
                s.setblocking(False)
                self.can_socks.append(s)
            except PermissionError as e:
                log.error(
                    "Permission denied opening %s. Run with sudo or grant CAP_NET_RAW: %s",
                    ifn, e
                )
                raise
        if not self.can_socks:
            raise RuntimeError("Failed to open any CAN sockets")

        # TCP listen socket
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind((self.host, self.port))
        self.srv.listen(8)
        self.srv.setblocking(False)

        # Client registry
        self.gvret_clients: Dict[socket.socket, GVRETClient] = {}

        # GVRET metadata - bus_count is the highest bus number + 1
        self.bus_count = self.bus_offset + len(self.can_socks)
        speeds = []
        db_speeds = []
        for ifn in self.ifaces:
            nominal, data = detect_bitrates(ifn)
            speeds.append(nominal)
            db_speeds.append(data)
        self.bus_speeds = tuple(speeds)
        self.bus_data_speeds = tuple(db_speeds)

        # Format ifaces with bus numbers: can0[0],can1[1] etc.
        iface_bus_strs = [f"{ifn}[{self.bus_offset + i}]" for i, ifn in enumerate(self.ifaces)]
        mode_str = "GVRET+FD" if self.can_fd else "GVRET"
        drates_str = ""
        if any(self.bus_data_speeds):
            drates_str = "  drates=" + ",".join(str(d or 0) for d in self.bus_data_speeds)
        pg_str = "  [PG ingest enabled]" if self.pg_writer else ""
        log.info(
            "Listening on %s:%d  mode=%s  ifaces=%s  rates=%s%s%s",
            self.host, self.port, mode_str, ",".join(iface_bus_strs),
            ",".join(str(s) for s in self.bus_speeds), drates_str, pg_str
        )

    # ---- accept/drop ----
    def _accept(self):
        conn, addr = self.srv.accept()
        conn.setblocking(False)
        log.info("Client %s:%d connected", addr[0], addr[1])
        gv = GVRETClient(conn, self.bus_count, self.bus_speeds, tx_func=self._tx_can)
        self.gvret_clients[conn] = gv

    def _drop(self, conn: socket.socket):
        # Log before closing so we can get the peer address
        try:
            addr = conn.getpeername()
            log.info("Client %s:%d disconnected", addr[0], addr[1])
        except Exception:
            log.info("Client disconnected")
        gv = self.gvret_clients.pop(conn, None)
        if gv:
            gv.close()
        try:
            conn.close()
        except Exception:
            pass

    # ---- tx ----
    def _tx_can(self, bus: int, can_id: int, data: bytes, is_fd: bool = False):
        # Route TX to the selected bus - subtract offset to get socket index
        sock_idx = bus - self.bus_offset
        if not 0 <= sock_idx < len(self.can_socks):
            return

        data_len = len(data)

        if is_fd and self.can_fd:
            # CAN FD frame: struct canfd_frame (72 bytes)
            # can_id (u32), len (u8), flags (u8), 2 reserved, 64 data
            data_len = min(data_len, 64)
            dlc = len_to_dlc(data_len)
            frame = struct.pack("<IBBBB64s", can_id, data_len, 0, 0, 0, data.ljust(64, b"\x00"))
        else:
            # Classic CAN frame: struct can_frame (16 bytes)
            dlc = min(data_len, 8)
            frame = struct.pack("<IB3x8s", can_id, dlc, data[:8].ljust(8, b"\x00"))
            is_fd = False  # Force to False if we're sending classic frame

        self.can_socks[sock_idx].send(frame)

        # Log TX frame to PostgreSQL
        if self.pg_writer:
            try:
                self.pg_writer.enqueue(
                    ts=time.time(),
                    can_id=can_id,
                    dlc=dlc,
                    data=data[:data_len],
                    bus=bus,
                    dir_="tx",
                    is_fd=is_fd,
                )
            except Exception:
                pass  # Don't let PG errors block TX

    # ---- main loop ----
    def run(self):
        """Run the main event loop, handling CAN frames and TCP clients."""
        while True:
            # Check for new TCP connections and CAN frames in one select call
            read_fds = [self.srv] + self.can_socks
            rlist, _, _ = select.select(read_fds, [], [], 0.02)

            for fd in rlist:
                if fd is self.srv:
                    self._accept()
                    continue

                # It's a CAN socket - apply bus_offset to get GVRET bus number
                bus_idx = self.bus_offset + self.can_socks.index(fd)

                # Drain ALL available frames from this socket to prevent buffer overflow
                while True:
                    try:
                        # Use recvmsg to get kernel timestamp from ancillary data
                        # Read 72 bytes for FD, 16 for classic
                        frame, ancdata, _flags, _addr = fd.recvmsg(self.frame_size, 1024)
                    except BlockingIOError:
                        break  # No more frames available
                    except Exception:
                        break

                    if not frame:
                        break

                    # Extract kernel timestamp from ancillary data, fall back to time.time()
                    now = time.time()
                    for cmsg_level, cmsg_type, cmsg_data in ancdata:
                        if cmsg_level == socket.SOL_SOCKET and cmsg_type == SO_TIMESTAMP:
                            # struct timeval: tv_sec (long), tv_usec (long) - 16 bytes on 64-bit
                            tv_sec, tv_usec = struct.unpack("ll", cmsg_data[:16])
                            now = tv_sec + tv_usec / 1_000_000.0
                            break

                    # Detect FD frame by size (72 bytes = FD, 16 bytes = classic)
                    is_fd_frame = len(frame) == 72

                    # Unpack frame header
                    if is_fd_frame:
                        # canfd_frame: can_id (u32), len (u8), flags (u8), 2 reserved, 64 data
                        can_id, data_len, fd_flags = struct.unpack_from("<IBB", frame, 0)
                        data = frame[8:8 + data_len]
                        dlc = len_to_dlc(data_len)
                    else:
                        # struct can_frame: can_id (u32), dlc (u8), 3 pad, 8 data
                        can_id, dlc = struct.unpack_from("<IB", frame, 0)
                        data_len = min(dlc, 8)
                        data = frame[8:8 + data_len]
                        fd_flags = 0

                    # optional console echo
                    if self.echo_console:
                        try:
                            line = format_candump_line(
                                frame, color_ascii=self.colour, t0_us=self.t0_us,
                                bus_idx=bus_idx, is_fd=is_fd_frame
                            )
                            sys.stdout.write(line)
                            sys.stdout.flush()
                        except Exception:
                            pass

                    # fan-out: GVRET
                    if self.gvret_clients:
                        dead = []
                        for c, gv in list(self.gvret_clients.items()):
                            try:
                                gv.send_frame(can_id, bus=bus_idx, data=data, is_fd=is_fd_frame)
                            except Exception:
                                dead.append(c)
                        for c in dead:
                            self._drop(c)

                    # postgres ingest (non-blocking enqueue)
                    if self.pg_writer:
                        try:
                            self.pg_writer.enqueue(
                                ts=now,
                                can_id=can_id,
                                dlc=dlc,
                                data=data,
                                bus=bus_idx,
                                dir_=self.default_dir,
                                is_fd=is_fd_frame,
                            )
                        except Exception as e:
                            # keep hot path resilient - rate limit error logs
                            if int(time.time()) % 10 == 0:
                                log.error("PG enqueue error: %s", e)


def load_config(path: Optional[str]) -> dict:
    """Load configuration from a TOML file."""
    if not path:
        return {}
    if not os.path.exists(path):
        raise FileNotFoundError(f"Config file not found: {path}")
    if not tomllib:
        raise RuntimeError("tomllib not available; use Python 3.11+ or omit --config")
    with open(path, "rb") as f:
        return tomllib.load(f)

def apply_config_overrides(args: argparse.Namespace, cfg: dict) -> argparse.Namespace:
    """
    Supported keys:

    [server]
    iface, host, port, bus_offset, echo_console, colour, default_dir, can_fd

    [postgres]
    enable, dsn, func, batch_size, flush_interval, queue_size, dir, cache_path,
    cache_max_mb

    [logging]
    level, stats_interval
    """
    server_conf = cfg.get("server", {})
    server_keys = (
        "iface", "host", "port", "bus_offset", "echo_console", "colour",
        "default_dir", "can_fd"
    )
    for cfg_key in server_keys:
        if cfg_key in server_conf:
            setattr(args, cfg_key, server_conf[cfg_key])

    postgres_conf = cfg.get("postgres", {})
    if postgres_conf.get("enable") is True:
        args.pg_enable = True

        for cfg_key, arg_key in {
            "dsn": "pg_dsn",
            "func": "pg_func",
            "batch_size": "pg_batch_size",
            "flush_interval": "pg_flush_interval",
            "queue_size": "pg_queue_size",
            "dir": "pg_dir",
            "cache_path": "pg_cache_path",
            "cache_max_mb": "pg_cache_max_mb",
            "queue_flush_pct": "pg_queue_flush_pct",
        }.items():
            if cfg_key in postgres_conf:
                setattr(args, arg_key, postgres_conf[cfg_key])

    logging_conf = cfg.get("logging", {})
    if "level" in logging_conf:
        args.log_level = str(logging_conf["level"]).upper()

    if "stats_interval" in logging_conf:
        args.stats_interval = float(logging_conf["stats_interval"])

    return args

def build_parser():
    """Build and parse command-line arguments."""
    ap = argparse.ArgumentParser(description="SocketCAN → TCP GVRET server")

    # Server / IO
    ap.add_argument("-i", "--iface",
        default="can0",
        help="CAN interface(s), comma-separated (default: can0). Example: can0,can1")
    ap.add_argument("--host",
        default="0.0.0.0",
        help="Listen address")
    ap.add_argument("-p", "--port",
        type=int,
        default=23,
        help="Listen port (default: 23)")
    ap.add_argument("--bus-offset",
        type=int,
        default=0,
        help="GVRET bus number offset (default: 0). First interface becomes bus N.")
    ap.add_argument("-e", "--echo-console",
        action="store_true",
        help="Echo frames to console in candump format")
    ap.add_argument("-c", "--colour",
        action="store_true",
        help="Highlight printable ASCII (only in console echo mode)")
    ap.add_argument("--default-dir",
        default="rx",
        help="Direction tag for DB ingest (default: rx)")
    ap.add_argument("--can-fd",
        action="store_true",
        help="Enable CAN FD support (64-byte payloads)")
    ap.add_argument("--log-level",
        default="INFO",
        choices=["DEBUG","INFO","WARNING","ERROR"],
        help="Logging level (default: INFO)")
    ap.add_argument("--stats-interval",
        type=float,
        default=10.0,
        help="Seconds between periodic stats logs (default: 10s; 0 disables)")

    # PostgreSQL ingest
    ap.add_argument(
        "--pg-enable", action="store_true",
        help="Enable Postgres ingest using import function")
    ap.add_argument(
        "--pg-dsn",
        help="Postgres DSN, e.g. postgresql://user:pass@host:5432/db")
    ap.add_argument(
        "--pg-func", default="public.ingest_can_frame",
        help="Qualified ingest function name")
    ap.add_argument(
        "--pg-batch-size", type=int, default=500,
        help="DB batch size (default 500)")
    ap.add_argument(
        "--pg-flush-interval", type=float, default=0.5,
        help="DB flush interval seconds (default 0.5)")
    ap.add_argument(
        "--pg-queue-size", type=int, default=50000,
        help="Max buffered frames (default 50000)")
    ap.add_argument(
        "--pg-dir", default=None,
        help="Override direction per row (default: uses --default-dir)")
    ap.add_argument(
        "--pg-cache-path", default=None,
        help="Disk cache path for outages (default: ~/.wiretap-server-cache.db)")
    ap.add_argument(
        "--pg-cache-max-mb", type=int, default=1000,
        help="Max disk cache size in MB (default: 1000)")
    ap.add_argument(
        "--pg-queue-flush-pct", type=int, default=50,
        help="Flush queue to disk when this full (default: 50%%)")

    # Config file (TOML)
    ap.add_argument("-C", "--config", help="Path to TOML config file that OVERRIDES CLI options")

    return ap.parse_args()

def main():
    """Entry point for the wiretap-server."""
    args = build_parser()

    # Handle SIGTERM (from kill, systemd, etc.) same as Ctrl+C
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    # Configuration file
    cfg = {}
    if args.config:
        cfg = load_config(args.config)
        args = apply_config_overrides(args, cfg)

    logging.basicConfig(
        level=getattr(logging, args.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # If DSN not given but env var exists, use it
    if not args.pg_dsn:
        env_dsn = os.getenv("PG_DSN")
        if env_dsn:
            args.pg_dsn = env_dsn

    # If cache path not given but env var exists, use it
    if not args.pg_cache_path:
        env_cache = os.getenv("PG_CACHE_PATH")
        if env_cache:
            args.pg_cache_path = env_cache

    # Optional Postgres writer
    pg_writer = None
    if args.pg_enable:
        if not args.pg_dsn:
            log.error("--pg-enable requires --pg-dsn (or PG_DSN env)")
            sys.exit(2)
        pg_writer = PostgresWriter(
            dsn=args.pg_dsn,
            ingest_func=args.pg_func,
            batch_size=args.pg_batch_size,
            flush_interval=args.pg_flush_interval,
            queue_max=args.pg_queue_size,
            default_dir=(args.pg_dir or args.default_dir),
            stats_interval=args.stats_interval,
            cache_path=args.pg_cache_path,
            cache_max_mb=args.pg_cache_max_mb,
            queue_flush_pct=args.pg_queue_flush_pct,
        )

    try:
        server = CanTcpServer(
            iface=args.iface,
            host=args.host,
            port=args.port,
            bus_offset=args.bus_offset,
            echo_console=args.echo_console,
            pg_writer=pg_writer,
            default_dir=(args.pg_dir or args.default_dir),
            can_fd=args.can_fd,
        )
        server.colour = args.colour
        server.run()
    except KeyboardInterrupt:
        log.info("Shutting down")
    except Exception as e:
        log.exception("Fatal error: %s", e)
        sys.exit(1)
    finally:
        if pg_writer:
            pg_writer.close()

if __name__ == "__main__":
    main()

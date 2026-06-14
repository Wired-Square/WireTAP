#!/usr/bin/env python3
"""
Migrate CAN frames from an existing PostgreSQL database into a TimescaleDB
hypertable on another server — e.g. moving a legacy capture archive into the
WireTAP backend container.

The target must already have the hypertable schema (the backend creates it on
first start from init_schema.sql). Frames are copied from `public.can_frame`
on --source-dsn into `public.can_frame` on --target-dsn, one day at a time:
each day is bulk-copied (binary COPY), validated by row count + checksum on
both ends, recorded for resumability, then its target chunk is compressed.
Re-run any time — completed days are skipped. When every day has landed, the
hourly continuous aggregate is refreshed over the imported range.

Stop new writes to the source first (e.g. switch the Pi to forward mode) so the
archive is static during the move.

Usage:
  ./migrate_to_timescale.py --source-dsn postgresql://... --target-dsn postgresql://...
  ./migrate_to_timescale.py --source-dsn ... --target-dsn ... --status

The source needs only SELECT on public.can_frame. To reach the container's
Postgres, temporarily publish its port (uncomment "127.0.0.1:5432:5432" in
tools/wiretap-backend/docker-compose.yml) or run this on the compose network.
"""

import argparse
import datetime
import sys
import tempfile
import time

import psycopg2

# The nine columns shared by the legacy table and the slimmed hypertable
# (the legacy row_id / id_hex / data_hex columns are intentionally dropped).
COLS = "ts, ingest_ts, id, extended, dlc, is_fd, data_bytes, bus, dir"

# Order-independent per-day fingerprint, identical on source and target. md5 is
# used (not hashtext) so it matches even when the two servers are different
# PostgreSQL major versions.
CHECKSUM = """
SELECT count(*)::bigint,
       coalesce(sum(('x' || substr(md5(
         id::text || extended::text || ts::text || ingest_ts::text ||
         encode(data_bytes, 'hex') || bus::text || dir), 1, 16))::bit(64)::bigint), 0)
FROM public.can_frame
WHERE ts >= %s::date AND ts < %s::date + INTERVAL '1 day'
"""

PROGRESS_TABLE = """
CREATE TABLE IF NOT EXISTS public.can_frame_migration (
  day         date        PRIMARY KEY,
  row_count   bigint      NOT NULL,
  checksum    numeric     NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
)
"""


def connect(dsn, name):
    conn = psycopg2.connect(dsn, application_name=f"migrate-{name}")
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute("SET timezone = 'UTC'")  # deterministic ts::text for checksums
    conn.commit()
    return conn


def query1(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        row = cur.fetchone()
    conn.commit()
    return row


def query_all(conn, sql, args=()):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        rows = cur.fetchall()
    conn.commit()
    return rows


def ensure_target(tgt):
    if query1(tgt, "SELECT 1 FROM pg_extension WHERE extname='timescaledb'") is None:
        sys.exit("target has no timescaledb extension — start the backend (or run init_schema.sql) first")
    if query1(tgt, "SELECT to_regclass('public.can_frame')")[0] is None:
        sys.exit("target has no public.can_frame table — run init_schema.sql on the target first")
    with tgt.cursor() as cur:
        cur.execute(PROGRESS_TABLE)
    tgt.commit()


def pending_days(src, tgt):
    """Whole days present in the source, oldest first, not yet migrated."""
    candidate = query_all(src, """
        SELECT d::date FROM generate_series(
          (SELECT date_trunc('day', min(ts)) FROM public.can_frame),
          (SELECT date_trunc('day', max(ts)) FROM public.can_frame),
          INTERVAL '1 day') d""")
    done = {r[0] for r in query_all(tgt, "SELECT day FROM public.can_frame_migration")}
    return [r[0] for r in candidate if r[0] not in done]


def migrate_day(src, tgt, day):
    # Dump the day to a spooled buffer (spills to disk past 128 MB) and
    # checksum the source side.
    buf = tempfile.SpooledTemporaryFile(max_size=128 * 1024 * 1024)
    with src.cursor() as cur:
        cur.copy_expert(
            f"COPY (SELECT {COLS} FROM public.can_frame "
            f"WHERE ts >= '{day}'::date AND ts < '{day}'::date + INTERVAL '1 day' "
            f"ORDER BY ts) TO STDOUT WITH BINARY", buf)
    src_n, src_sum = query1(src, CHECKSUM, (day, day))

    # Load + validate + record in one target transaction (DELETE clears any
    # partial copy left by a failed earlier run).
    buf.seek(0)
    with tgt.cursor() as cur:
        cur.execute("DELETE FROM public.can_frame "
                    "WHERE ts >= %s::date AND ts < %s::date + INTERVAL '1 day'", (day, day))
        cur.copy_expert(f"COPY public.can_frame ({COLS}) FROM STDIN WITH BINARY", buf)
        cur.execute(CHECKSUM, (day, day))
        tgt_n, tgt_sum = cur.fetchone()
        if (src_n, src_sum) != (tgt_n, tgt_sum):
            tgt.rollback()
            sys.exit(f"VALIDATION FAILED for {day}: "
                     f"source=({src_n},{src_sum}) target=({tgt_n},{tgt_sum})")
        cur.execute("INSERT INTO public.can_frame_migration (day, row_count, checksum) "
                    "VALUES (%s, %s, %s)", (day, src_n, src_sum))
    tgt.commit()
    buf.close()

    # Compress this day's chunk. Oldest-first means it is never written again;
    # best-effort — the target's compression policy will catch any straggler.
    tgt.autocommit = True
    try:
        with tgt.cursor() as cur:
            cur.execute(
                "SELECT compress_chunk(c, if_not_compressed => TRUE) "
                "FROM show_chunks('public.can_frame', newer_than => %s::date, "
                "older_than => %s::date + INTERVAL '1 day') c", (day, day))
    except psycopg2.Error as e:
        print(f"  warning: compress {day} failed ({e}); policy will retry")
    finally:
        tgt.autocommit = False
    return src_n


def refresh_rollup(tgt):
    if query1(tgt, "SELECT to_regclass('public.can_frame_hourly')")[0] is None:
        return
    start, end = query1(tgt, "SELECT date_trunc('month', min(ts)), max(ts) FROM public.can_frame")
    if start is None:
        return
    print("refreshing can_frame_hourly...")
    tgt.autocommit = True
    with tgt.cursor() as cur:
        while start < end:
            nxt = min((start + datetime.timedelta(days=32)).replace(day=1), end)
            cur.execute("CALL refresh_continuous_aggregate('public.can_frame_hourly', %s, %s)",
                        (start, nxt))
            print(f"  {start:%Y-%m}")
            start = nxt
    tgt.autocommit = False


def status(src, tgt):
    n_days, n_rows, first, last = query1(
        tgt, "SELECT count(*), coalesce(sum(row_count), 0), min(day), max(day) "
             "FROM public.can_frame_migration")
    print(f"migrated: {n_days} day(s), {n_rows} rows ({first} .. {last})")
    print(f"pending days: {len(pending_days(src, tgt))}")


def main():
    ap = argparse.ArgumentParser(
        description="Cross-server migration of public.can_frame into a TimescaleDB hypertable")
    ap.add_argument("--source-dsn", required=True, help="Existing database to read from")
    ap.add_argument("--target-dsn", required=True, help="TimescaleDB database to write into")
    ap.add_argument("--status", action="store_true", help="Show progress and exit")
    args = ap.parse_args()

    src = connect(args.source_dsn, "source")
    tgt = connect(args.target_dsn, "target")
    try:
        ensure_target(tgt)
        if args.status:
            status(src, tgt)
            return
        days = pending_days(src, tgt)
        if not days:
            print("nothing to migrate (all days already done)")
        else:
            print(f"migrating {len(days)} day(s): {days[0]} .. {days[-1]}")
            for day in days:
                t0 = time.time()
                n = migrate_day(src, tgt, day)
                print(f"  {day}: {n} rows ({time.time() - t0:.1f}s)")
        refresh_rollup(tgt)
        status(src, tgt)
    finally:
        src.close()
        tgt.close()


if __name__ == "__main__":
    main()

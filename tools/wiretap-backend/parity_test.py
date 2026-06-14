#!/usr/bin/env python3
"""
Phase D parity test: the backend's ported analytical SQL must agree with
ground truth computed directly in PostgreSQL on the same database. This is
the guard against drift between backend/src/sql.rs and the desktop's
src-tauri/src/dbquery.rs (which run near-identical SQL).

Imports a deterministic dataset via the import API, then for each query type
compares the API result against a direct psql computation.

Usage: ./parity_test.py [base-url] [admin-key]
"""
import json
import struct
import subprocess
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8423"
KEY = sys.argv[2] if len(sys.argv) > 2 else "dev-admin-key"
DB = f"parity_{int(time.time())}"
PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def api(method, path, body=None, raw=None):
    url = f"{BASE}{path}"
    headers = {"Authorization": f"Bearer {KEY}"}
    data = None
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/x-wiretap-frames"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def psql(sql):
    """Run SQL in the container and return rows as list of tuples (text)."""
    out = subprocess.check_output(
        ["docker", "compose", "exec", "-T", "timescaledb",
         "psql", "-U", "postgres", "-d", DB, "-tA", "-F", "|", "-c", sql],
        text=True,
    )
    return [line.split("|") for line in out.strip().splitlines() if line]


# --- deterministic dataset ---------------------------------------------------
# Frame 0x100: byte0 ramps 0..199 (every frame changes), 10ms apart, with one
# 5s gap injected. Frame 0x200: constant. Two ids for inventory/mux coverage.
ID_EXTENDED = 1 << 29


def record(ts_us, arb, payload, extended=False):
    flags = (arb & 0x1FFFFFFF) | (ID_EXTENDED if extended else 0)
    return struct.pack("<qIBB", ts_us, flags, 0, len(payload)) + payload


def build_dataset():
    base = 1_700_000_000_000_000  # fixed epoch us (deterministic)
    buf = bytearray()
    t = base
    for i in range(200):
        # inject a 5s gap before frame 100
        if i == 100:
            t += 5_000_000
        else:
            t += 10_000
        buf += record(t, 0x100, bytes([i & 0xFF, (i * 3) & 0xFF, 0x00, 0xFF]))
    # 0x200 constant payload, 50 frames
    for i in range(50):
        buf += record(base + i * 20_000, 0x200, bytes([0xAB, 0xCD]))
    return bytes(buf), base


def main():
    data, base = build_dataset()
    res = api("POST", f"/v1/db/{DB}/import?create=true", raw=data)
    check("import deterministic dataset", res.get("imported") == 250, res)
    time.sleep(0.5)

    # --- inventory: counts/min/max per id vs psql ---
    inv = {e["frame_id"]: e for e in api("GET", f"/v1/db/{DB}/inventory")["entries"]}
    gt = {int(r[0]): r for r in psql(
        "SELECT id, count(*), max(dlc) FROM can_frame GROUP BY id ORDER BY id")}
    check("inventory id 0x100 count", inv.get(256, {}).get("count") == int(gt[256][1]),
          f"api={inv.get(256,{}).get('count')} gt={gt[256][1]}")
    check("inventory id 0x200 count", inv.get(512, {}).get("count") == int(gt[512][1]))
    check("inventory max_dlc", inv.get(256, {}).get("max_dlc") == int(gt[256][2]))

    # --- first-last: count + first/last payload vs psql ---
    fl = api("POST", f"/v1/db/{DB}/query/first-last", {"frame_id": 256})["results"]
    gt = psql("SELECT count(*), "
              "(SELECT encode(data_bytes,'hex') FROM can_frame WHERE id=256 ORDER BY ts ASC LIMIT 1), "
              "(SELECT encode(data_bytes,'hex') FROM can_frame WHERE id=256 ORDER BY ts DESC LIMIT 1) "
              "FROM can_frame WHERE id=256")[0]
    api_first = bytes(fl["first_payload"]).hex()
    api_last = bytes(fl["last_payload"]).hex()
    check("first-last count", fl["total_count"] == int(gt[0]), f"api={fl['total_count']} gt={gt[0]}")
    check("first-last first payload", api_first == gt[1], f"api={api_first} gt={gt[1]}")
    check("first-last last payload", api_last == gt[2], f"api={api_last} gt={gt[2]}")

    # --- distribution of byte0 for 0x100: every value 0..199 appears once ---
    dist = api("POST", f"/v1/db/{DB}/query/distribution",
               {"frame_id": 256, "byte_index": 0})["results"]
    gt = psql("SELECT count(DISTINCT get_byte(data_bytes,0)), count(*) FROM can_frame WHERE id=256")[0]
    total_api = sum(d["count"] for d in dist)
    check("distribution distinct values", len(dist) == int(gt[0]), f"api={len(dist)} gt={gt[0]}")
    check("distribution total count", total_api == int(gt[1]), f"api={total_api} gt={gt[1]}")

    # --- byte-changes for 0x100 byte0: changes every frame => 199 changes ---
    bc = api("POST", f"/v1/db/{DB}/query/byte-changes",
             {"frame_id": 256, "byte_index": 0, "limit": 1000})["results"]
    gt = psql(
        "SELECT count(*) FROM (SELECT get_byte(data_bytes,0) v, "
        "LAG(get_byte(data_bytes,0)) OVER (ORDER BY ts) p FROM can_frame WHERE id=256) s "
        "WHERE p IS NOT NULL AND p IS DISTINCT FROM v")[0]
    check("byte-changes count", len(bc) == int(gt[0]), f"api={len(bc)} gt={gt[0]}")

    # byte0 of 0x200 is constant => zero changes
    bc2 = api("POST", f"/v1/db/{DB}/query/byte-changes",
              {"frame_id": 512, "byte_index": 0})["results"]
    check("byte-changes constant byte = 0", len(bc2) == 0)

    # --- gap-analysis: exactly one gap > 1s (the injected 5s gap) ---
    gaps = api("POST", f"/v1/db/{DB}/query/gap-analysis",
               {"frame_id": 256, "gap_threshold_ms": 1000})["results"]
    check("gap-analysis finds the 5s gap", len(gaps) == 1, f"got {len(gaps)}")
    if gaps:
        check("gap duration ~5000ms", abs(gaps[0]["duration_ms"] - 5000.0) < 1.0,
              f"got {gaps[0]['duration_ms']}")

    # --- frequency: total interval count == frames-1, buckets match psql ---
    freq = api("POST", f"/v1/db/{DB}/query/frequency",
               {"frame_id": 256, "bucket_size_ms": 1000})["results"]
    total_intervals = sum(b["frame_count"] for b in freq)
    check("frequency interval total = N-1", total_intervals == 199, f"got {total_intervals}")
    # bucket_size_ms=1000 -> bucket_us=1_000_000; bucket key = trunc(epoch_us / bucket_us)
    gt = psql(
        "SELECT count(*) FROM (SELECT trunc((EXTRACT(EPOCH FROM ts)*1000000)/1000000) b "
        "FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) p FROM can_frame WHERE id=256) s "
        "WHERE p IS NOT NULL GROUP BY b) x")[0]
    check("frequency bucket count matches psql", len(freq) == int(gt[0]),
          f"api={len(freq)} gt={gt[0]}")

    # --- pattern search: byte2=0x00 AND byte3=0xFF present in all 0x100 frames ---
    ps = api("POST", f"/v1/db/{DB}/query/pattern-search",
             {"pattern": [0x00, 0xFF], "pattern_mask": [0xFF, 0xFF], "limit": 1000})["results"]
    # 0x100 has bytes [.., .., 00, FF] -> matches at offset 2 (200 frames)
    matches_100 = [m for m in ps if m["frame_id"] == 256]
    check("pattern-search matches all 0x100 frames", len(matches_100) == 200,
          f"got {len(matches_100)}")

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()

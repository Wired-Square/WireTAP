#!/bin/bash
# Phase B smoke test: endpoint coverage + auth matrix against a running stack.
# Usage: ./smoke_test.sh [base-url] [admin-key] [seeded-db]
set -u
BASE="${1:-http://localhost:8423}"
ADMIN_KEY="${2:-dev-admin-key}"
DB="${3:-vehicle_test}"
PASS=0; FAIL=0

check() { # name, condition (0 = ok)
    if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "  [ok] $1"
    else FAIL=$((FAIL+1)); echo "  [FAIL] $1"; fi
}

A="Authorization: Bearer $ADMIN_KEY"
J="Content-Type: application/json"

# --- health + auth basics ---
curl -fsS "$BASE/v1/health" | grep -q '"status":"ok"'; check "health ok" $?
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/databases")
[ "$code" = "401" ]; check "no token -> 401" $?
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer nope" "$BASE/v1/databases")
[ "$code" = "401" ]; check "bad token -> 401" $?

# --- key lifecycle ---
read_key=$(curl -fsS -H "$A" -H "$J" -d '{"name":"smoke-read","role":"read"}' "$BASE/v1/admin/keys" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
[ -n "$read_key" ]; check "create read key returns plaintext" $?
R="Authorization: Bearer $read_key"
curl -fsS -H "$R" "$BASE/v1/databases" | grep -q "$DB"; check "read key lists databases" $?
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$R" -H "$J" -d '{"name":"nope_db"}' "$BASE/v1/databases")
[ "$code" = "403" ]; check "read key cannot create database" $?
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$R" "$BASE/v1/admin/keys")
[ "$code" = "403" ]; check "read key cannot list keys" $?

# --- read endpoints over seeded data ---
curl -fsS -H "$R" "$BASE/v1/db/$DB/time-bounds" | grep -q min_ts_us; check "time-bounds" $?
inv=$(curl -fsS -H "$R" "$BASE/v1/db/$DB/inventory")
echo "$inv" | grep -q '"frame_id":2016'; check "inventory contains seeded id 0x7E0" $?
curl -fsS -H "$R" -H "$J" -d '{"frame_id":2016,"limit":5}' "$BASE/v1/db/$DB/payloads" | grep -q payloads; check "payloads" $?

# frames cursor: page through with limit=30, expect >=80 frames total, no dupes
total=$(python3 - "$BASE" "$read_key" "$DB" <<'EOF'
import json, sys, urllib.request
base, key, db = sys.argv[1:4]
url = f"{base}/v1/db/{db}/frames?limit=30"
seen, cursor, total = set(), None, 0
while True:
    u = url + (f"&after={cursor}" if cursor else "")
    req = urllib.request.Request(u, headers={"Authorization": f"Bearer {key}"})
    data = json.load(urllib.request.urlopen(req))
    for f in data["frames"]:
        total += 1
        seen.add((f["ts_us"], f["id"], f["data_hex"], total))  # total makes dupes visible only via count
    cursor = data.get("next_cursor")
    if not cursor:
        break
print(total)
EOF
)
[ "$total" -ge 80 ]; check "frames cursor pages all rows (got $total)" $?

# --- analytical queries ---
q() { curl -fsS -H "$R" -H "$J" -d "$2" "$BASE/v1/db/$DB/query/$1"; }
q first-last '{"frame_id":2016}' | grep -q total_count; check "query first-last" $?
q distribution '{"frame_id":2016,"byte_index":0}' | grep -q percentage; check "query distribution" $?
q byte-changes '{"frame_id":2016,"byte_index":0}' | grep -q results; check "query byte-changes" $?
q frame-changes '{"frame_id":2016}' | grep -q results; check "query frame-changes" $?
q frequency '{"frame_id":2016,"bucket_size_ms":1000}' | grep -q results; check "query frequency" $?
q gap-analysis '{"frame_id":2016,"gap_threshold_ms":1}' | grep -q results; check "query gap-analysis" $?
q mux-statistics '{"frame_id":2016,"mux_selector_byte":0,"include_16bit":true,"payload_length":8}' | grep -q cases; check "query mux-statistics" $?
q pattern-search '{"pattern":[0],"pattern_mask":[0]}' | grep -q results; check "query pattern-search (match-all mask)" $?
q mirror-validation '{"mirror_frame_id":2016,"source_frame_id":2017,"tolerance_ms":100}' | grep -q results; check "query mirror-validation" $?

# --- import: 1000 synthetic records into a fresh auto-created db ---
# Unique db name per run so the count assertion is idempotent.
IMPORT_DB="smoke_import_$(date +%s)"
python3 - <<'EOF' > /tmp/wiretap_import.bin
import struct, sys, time
base = int(time.time() * 1_000_000)
out = sys.stdout.buffer
for i in range(1000):
    payload = struct.pack("<II", i, i * 2)
    out.write(struct.pack("<qIBB", base + i * 1000, 0x300 + (i % 4), 0, len(payload)) + payload)
EOF
resp=$(curl -fsS -H "$A" -H "Content-Type: application/x-wiretap-frames" \
    --data-binary @/tmp/wiretap_import.bin "$BASE/v1/db/$IMPORT_DB/import?create=true")
echo "$resp" | grep -q '"imported":1000'; check "import 1000 records into auto-created db" $?
cnt=$(curl -fsS -H "$R" -H "$J" -d '{"frame_id":768}' "$BASE/v1/db/$IMPORT_DB/query/first-last" | python3 -c 'import sys,json;print(json.load(sys.stdin)["results"]["total_count"])')
[ "$cnt" = "250" ]; check "imported frames queryable (0x300 count=$cnt)" $?
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$R" -H "Content-Type: application/x-wiretap-frames" --data-binary @/tmp/wiretap_import.bin "$BASE/v1/db/$IMPORT_DB/import")
[ "$code" = "403" ]; check "read key cannot import" $?

# --- admin views ---
curl -fsS -H "$A" "$BASE/v1/db/$DB/activity" | grep -q queries; check "activity" $?
curl -fsS -H "$A" "$BASE/v1/admin/ingest-sessions" | grep -q sessions; check "ingest-sessions" $?

# --- revocation ---
kid=$(curl -fsS -H "$A" "$BASE/v1/admin/keys" | python3 -c 'import sys,json;ks=json.load(sys.stdin)["keys"];print([k["id"] for k in ks if k["name"]=="smoke-read" and not k["revoked"]][-1])')
curl -fsS -X DELETE -H "$A" "$BASE/v1/admin/keys/$kid" | grep -q revoked; check "revoke read key" $?
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$R" "$BASE/v1/databases")
[ "$code" = "401" ]; check "revoked key -> 401 immediately" $?

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

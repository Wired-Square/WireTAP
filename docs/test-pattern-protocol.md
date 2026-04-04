# Test Pattern Protocol

**Status:** Draft
**Transports:** CAN, CAN FD, Serial, GVRET TCP

Test Pattern is a lightweight wire protocol for validating WireTAP's I/O stack end-to-end across real hardware. Two endpoints (WireTAP instances, or a WireTAP instance and the `transport_test.py` script) exchange test frames over a physical link, measuring round-trip integrity, throughput, and latency.

---

## 1. Roles

| Role          | Behaviour                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------- |
| **Initiator** | Sends test frames (pings, probes, throughput stream). Tracks responses and computes metrics. |
| **Responder** | Listens for test frames and replies immediately. Tracks receive counts and reports status.   |

Either endpoint can take either role. Two WireTAP instances can test against each other, or one side can be the `transport_test.py` script on a headless Linux machine.

---

## 2. Test Payload

Every Test Pattern message carries an **8-byte payload**, regardless of transport. This fits within a single classic CAN frame.

```
Byte 0    Tag (message type identifier)
Byte 1    Flags
Bytes 2-3 Sequence counter (big-endian unsigned 16-bit)
Bytes 4-7 Type-specific payload
```

### 2.1 Tag (Byte 0)

| Value | Name | Direction |
|-------|------|-----------|
| `0x01` | Ping request | Initiator -> Responder |
| `0x02` | Ping response | Responder -> Initiator |
| `0x03` | Throughput stream | Either direction |
| `0x04` | Latency probe | Initiator -> Responder |
| `0x05` | Latency reply | Responder -> Initiator |
| `0x06` | Control command | Either direction |
| `0x07` | Status report | Either direction |

### 2.2 Flags (Byte 1)

```
Bit 0:    Data mode         0 = Frames, 1 = Bytes
Bits 1-3: Interface index   0-7 (applies to both modes)
Bits 4-7: Reserved          Must be 0
```

- **Frames mode** (bit 0 = 0): Payload is carried inside CAN/CAN FD frames with arbitration IDs.
- **Bytes mode** (bit 0 = 1): Payload is carried as raw bytes (e.g. over a serial link, MQTT, or any byte-stream transport). No frame IDs — the tag byte alone identifies the message type.

The interface index field applies to both modes, supporting multi-bus CAN setups and multi-port serial configurations alike. This aligns with WireTAP's `SessionDataStreams` model (`rx_frames` / `rx_bytes`).

### 2.3 Sequence Counter (Bytes 2-3)

Big-endian unsigned 16-bit integer. Incremented by the sender for each transmitted frame within a test run. Wraps from 65535 to 0.

- A **gap** in the received sequence indicates dropped frames.
- A **repeated** sequence number indicates duplicates.
- A **backwards jump** (other than the 65535->0 wrap) indicates reordering.

### 2.4 Type-Specific Payload (Bytes 4-7)

#### Ping Request (`0x01`) / Ping Response (`0x02`)

```
Bytes 4-7: 0x00 0x00 0x00 0x00
```

The responder copies the initiator's sequence counter (bytes 2-3) into the response, allowing the initiator to match each response to its request.

#### Throughput Stream (`0x03`)

```
Byte 4:    Pattern ID (identifies fill pattern for CAN FD extended data)
Bytes 5-7: 0x00 0x00 0x00
```

Pattern IDs (for CAN FD bytes 8-63):

| ID | Pattern | Description |
|----|---------|-------------|
| `0x00` | Sequential | `bytes[i] = i & 0xFF` |
| `0x01` | Walking bit | Repeating `01 02 04 08 10 20 40 80` |
| `0x02` | Counter fill | All bytes set to `seq & 0xFF` |
| `0x03` | Alternating | Repeating `AA 55` |
| `0xFF` | None | No extended data (classic CAN) |

#### Latency Probe (`0x04`) / Latency Reply (`0x05`)

```
Bytes 4-7: Timestamp (big-endian unsigned 32-bit, low 32 bits of microsecond clock)
```

The initiator writes its current microsecond timestamp into bytes 4-7. The responder echoes these four bytes unchanged in the reply. The initiator computes round-trip time as `now_us - echoed_timestamp`.

Note: The 32-bit microsecond value wraps every ~71.6 minutes. The initiator must handle wrap-around when computing RTT.

#### Control Command (`0x06`)

```
Byte 4:    Command code
Bytes 5-6: Parameter (big-endian unsigned 16-bit)
Byte 7:    0x00
```

| Command | Code | Parameter |
|---------|------|-----------|
| Start test | `0x01` | Test mode (1=echo, 2=throughput, 3=latency, 4=reliability) |
| Stop test | `0x02` | Unused (0x0000) |
| Set rate | `0x03` | Target frames/sec |
| Request status | `0x04` | Unused (0x0000) |

#### Status Report (`0x07`)

Status reports carry one metric per frame, identified by a field ID. The initiator sends a `Request status` control command (`0x04`), and the responder replies with a burst of status report frames.

```
Byte 0:    0x07 (tag)
Byte 1:    Flags
Bytes 2-3: Reserved (0x0000, occupies the sequence counter position)
Byte 4:    Field ID
Bytes 5-7: Value (big-endian unsigned 24-bit)
```

| Field ID | Name | Description |
|----------|------|-------------|
| `0x00` | RX count | Total frames received by the responder |
| `0x01` | TX count | Total frames transmitted by the responder |
| `0x02` | Drops | Frames dropped by the responder |
| `0x03` | FPS | Current receive rate (frames/sec) |

The 24-bit value supports counts up to 16,777,215. The responder sends one frame per field (4 frames total) in response to a status request.

---

## 3. CAN Transport Mapping

### 3.1 Frame IDs

Standard (11-bit) IDs in the range `0x7F0`-`0x7F7`:

| Frame ID | Message Type                        |
| -------- | ----------------------------------- |
| `0x7F0`  | Ping request                        |
| `0x7F1`  | Ping response                       |
| `0x7F2`  | Throughput (initiator -> responder) |
| `0x7F3`  | Throughput (responder -> initiator) |
| `0x7F4`  | Latency probe                       |
| `0x7F5`  | Latency reply                       |
| `0x7F6`  | Control command                     |
| `0x7F7`  | Status report                       |

For extended (29-bit) ID testing, use `0x1F0007F0`-`0x1F0007F7` (high bits `0x1F000` as a distinctive marker, low nibble matches standard IDs).

### 3.2 Classic CAN

DLC = 8. Payload is the 8-byte test payload defined above.

### 3.3 CAN FD

DLC = 64 (or configurable). Bytes 0-7 are the standard test payload. Bytes 8-63 are filled with a verifiable pattern identified by the `pattern_id` field (byte 4) in throughput frames.

For non-throughput frame types (ping, latency, control, status), bytes 8-63 are filled with `0x00`.

The responder should verify the CAN FD fill pattern on received throughput frames and flag any byte mismatches as data corruption errors.

### 3.4 Frame Flags

| Flag | Usage |
|------|-------|
| `is_fd` | Set for CAN FD test frames |
| `is_brs` | Set when testing with Bit Rate Switch enabled |
| `is_extended` | Set when using 29-bit extended IDs |
| `is_rtr` | Not used by Test Pattern |

---

## 4. Bytes Transport Mapping

For serial and other byte-stream transports, the 8-byte test payload is wrapped in a framing protocol with a `0x00` delimiter.

### 4.1 Framing

The framing protocol is configurable via the `--framing` flag in `transport_test.py`. Two protocols are supported:

**COBS (default)** — [Consistent Overhead Byte Stuffing](https://en.wikipedia.org/wiki/Consistent_Overhead_Byte_Stuffing). Delimiter: `0x00`.

```
Wire format: <COBS-encoded payload> 0x00
```

COBS guarantees no `0x00` bytes within the encoded data, making the delimiter unambiguous. Fixed overhead of 1-2 bytes for an 8-byte payload.

**SLIP** — [Serial Line Internet Protocol (RFC 1055)](https://datatracker.ietf.org/doc/html/rfc1055). Delimiter: `0xC0` (END).

```
Wire format: <SLIP-escaped payload> 0xC0
```

SLIP escapes `0xC0` as `0xDB 0xDC` and `0xDB` as `0xDB 0xDD`. Zero overhead when the payload contains neither byte; 1 byte per occurrence otherwise.

| Protocol | Delimiter | Overhead (8-byte payload) | Notes |
|----------|-----------|--------------------------|-------|
| COBS | `0x00` | 1-2 bytes | Deterministic overhead |
| SLIP | `0xC0` (END) | 0-8 bytes (data-dependent) | Widely supported in embedded |

### 4.2 Payload

No CAN frame IDs are used — the tag byte (byte 0) alone identifies the message type. The flags byte (byte 1) has bit 0 set to `1` to indicate bytes mode. Bits 1-3 carry the interface index, supporting multi-port serial configurations.

---

## 5. GVRET TCP Transport Mapping

The [GVRET binary protocol](gvret-protocol.md) can carry Test Pattern frames over a TCP connection. This allows testing WireTAP's GVRET TCP stack without CAN hardware — the script emulates a GVRET device.

### 5.1 Modes

| Mode | Flag | Behaviour |
|------|------|-----------|
| **Client** | `--gvret` | Connects to a GVRET device (or another script in server mode). Sends the binary mode init (`0xE7 0xE7`), queries bus count. |
| **Server** | `--gvret-listen` | Listens on a TCP port, waits for a client (e.g. WireTAP) to connect. Responds to GVRET handshake commands (bus count, device info, CAN params). |

### 5.2 Frame Encoding

Test Pattern payloads are carried inside standard GVRET CAN frames. The 8-byte test payload occupies the CAN data field. Frame IDs `0x7F0`-`0x7F7` are used, same as the CAN transport mapping (section 3.1).

**Client → Device (TX format):**

```
F1 00 [frame_id:4LE] [bus:1] [len:1] [data:8]
```

**Device → Client (RX format):**

```
F1 00 [timestamp:4LE] [frame_id:4LE] [bus_dlc:1] [data:8] [checksum:1]
```

Where `bus_dlc` encodes bus number in the upper nibble and DLC in the lower nibble: `(bus << 4) | dlc`.

In server mode, the script sends frames in device RX format so WireTAP can parse them. In client mode, the script sends in client TX format as a normal GVRET client would.

### 5.3 Handshake (Server Mode)

When running as a GVRET TCP server, the script handles the standard GVRET initialisation sequence:

1. **Binary mode enable** — strips incoming `0xE7` bytes
2. **Bus count query** (`F1 0C`) — responds with `F1 0C <num_buses>`
3. **Device info probe** (`F1 07`) — responds with dummy device info
4. **CAN params query** (`F1 06`) — responds with 500 kbps per bus
5. **Time sync** (`F1 01`) — responds with current monotonic timestamp

After handshake, both sides exchange CAN frames carrying Test Pattern payloads.

### 5.4 Use Cases

**Testing without CAN hardware:** Run the script as a GVRET TCP server. Point WireTAP's GVRET TCP profile at the script's IP and port. WireTAP connects, completes the handshake, and starts streaming — no physical CAN bus needed.

**Testing the GVRET stack end-to-end:** The script exercises the same GVRET binary codec and TCP session management that WireTAP uses for real GVRET devices, validating frame encoding, bus routing, and session lifecycle.

---

## 6. Test Modes

### 6.1 Echo (Ping-Pong)

The initiator sends ping requests at a configurable rate (default 10 Hz). The responder replies to each ping with a matching sequence number. The initiator tracks which sequence numbers received a response.

**Metrics:**
- Response rate (% of pings answered)
- Dropped frame count (no response received)
- Duplicate count (same sequence seen twice)
- Out-of-order count

### 6.2 Throughput

The initiator sends throughput frames as fast as the transport allows. The responder counts received frames and optionally sends its own counter stream back. Both sides report final counts after the test duration.

**Metrics:**
- TX frames/sec (sustained)
- RX frames/sec (sustained)
- Frame loss percentage
- Data corruption errors (CAN FD pattern mismatch)

### 6.3 Latency

The initiator sends latency probes at a low rate (default 1 Hz to avoid queuing effects). The responder echoes the timestamp bytes immediately. The initiator computes RTT on receipt.

**Metrics:**
- Round-trip time: min, max, mean, p50, p95, p99 (microseconds)
- Probe loss count

### 6.4 Reliability

Combines echo mode at moderate rate (e.g. 100 Hz) over extended duration (minutes to hours). Every sequence number is tracked for the full run.

**Metrics:**
- Total TX / RX counts
- Cumulative drops, skips, duplicates
- Errors over time
- Drops-per-minute trend

### 6.5 Loopback

Uses WireTAP's Virtual Device with loopback enabled. The initiator and responder run within the same WireTAP instance. No external hardware or script needed. Useful as a smoke test on any platform.

---

## 7. Sequence Analysis

The sequence counter enables precise detection of transport issues:

| Condition | Detection | Meaning |
|-----------|-----------|---------|
| `rx_seq == expected` | Normal | Frame delivered correctly |
| `rx_seq > expected` | Gap of `rx_seq - expected` | Frames were dropped |
| `rx_seq < expected` (not wrap) | Out-of-order | Transport reordered frames |
| `rx_seq == prev_rx_seq` | Duplicate | Frame delivered twice |
| `rx_seq == 0 && prev == 65535` | Normal wrap | Counter wrapped, not a gap |

For reliability mode, all gaps are recorded as `(expected_seq, actual_seq)` pairs for post-mortem analysis.

---

## 8. Implementations

### 8.1 `scripts/transport_test.py`

Multi-transport command-line tool. Supports four transport backends:

**SocketCAN (Linux):**
```bash
python3 transport_test.py --echo-responder -i can0
python3 transport_test.py --roundtrip -i can0 --rate 100 --duration 30
python3 transport_test.py --throughput -i can0 --duration 10 --canfd
python3 transport_test.py --roundtrip -i can0 --json-report results.json
```

**Serial (COBS or SLIP framing):**
```bash
python3 transport_test.py --serial --echo-responder --port /dev/ttyUSB0
python3 transport_test.py --serial --roundtrip --port /dev/ttyUSB0 --baud 115200
python3 transport_test.py --serial --latency --port /dev/ttyUSB0 --framing slip
```

**GVRET TCP — client (connects to a GVRET device):**
```bash
python3 transport_test.py --gvret --echo-responder --host 192.168.1.10 --gvret-port 9999
python3 transport_test.py --gvret --roundtrip --host 192.168.1.10 --rate 100
```

**GVRET TCP — server (WireTAP connects to us):**
```bash
python3 transport_test.py --gvret-listen --echo-responder --host 0.0.0.0 --gvret-port 9999
python3 transport_test.py --gvret-listen --roundtrip --host 0.0.0.0 --rate 100 --num-buses 3
```

In server mode, the script emulates a GVRET device — WireTAP can connect with a GVRET TCP profile and exchange Test Pattern frames without any CAN hardware.

### 8.2 WireTAP — Test Pattern Panel

Dockview panel in WireTAP. Select an active session with transmit capability, choose a role (initiator or responder), select a test mode, and run. Live counters update during the test; a summary is shown on completion.

Two WireTAP instances on separate machines can test against each other — one as initiator, one as responder.

### 8.3 Headless Testing

The Rust backend test runner can be driven without the Tauri GUI for automated and CI testing.

#### Virtual Device Loopback (Any Platform)

Run the built-in integration tests using the Virtual Device with loopback enabled. No hardware required.

```bash
cd src-tauri
cargo test io_test -- --nocapture
```

This creates a Virtual Device session with `loopback: true`, runs each test mode, and asserts on metrics (0 drops for echo, sequence integrity for throughput, RTT within bounds for latency).

#### Cross-Machine CAN Testing

On the Linux machine (responder):

```bash
# Set up the physical CAN interface
sudo ip link set can0 type can bitrate 500000
sudo ip link set up can0

# Start the echo responder
python3 scripts/transport_test.py --echo-responder -i can0
```

On the WireTAP machine (initiator):

1. Open WireTAP and connect to the CAN interface (gs_usb, slcan, etc.)
2. Open the **Test Pattern** panel
3. Select the session, set role to **Initiator**, choose a test mode
4. Click **Start** — live counters show TX, RX, drops, and RTT
5. On completion, review the summary for pass/fail

#### Cross-Machine CAN FD Testing

On the Linux machine:

```bash
# Set up physical CAN FD interface with data bitrate
sudo ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on
sudo ip link set up can0

# Start echo responder in CAN FD mode
python3 scripts/transport_test.py --echo-responder -i can0 --canfd
```

On the WireTAP machine, same steps as above with the CAN FD toggle enabled in the Test Pattern panel.

#### GVRET TCP Testing (No CAN Hardware)

On the test machine (GVRET server + echo responder):

```bash
python3 scripts/transport_test.py --gvret-listen --echo-responder \
  --host 0.0.0.0 --gvret-port 9999
```

On the WireTAP machine:

1. Add a **GVRET TCP** profile in Settings, pointing at the test machine's IP and port 9999
2. Open the **Test Pattern** panel
3. Select the GVRET TCP session, set role to **Initiator**, choose a test mode
4. Click **Start**

This tests the full GVRET TCP stack (binary codec, session lifecycle, frame routing) without physical CAN hardware.

#### WireTAP-to-WireTAP Testing

No script needed. Two machines, each running WireTAP with real hardware:

- **Machine A**: Open Test Pattern panel, select session, role = **Responder**, click Start
- **Machine B**: Open Test Pattern panel, select session, role = **Initiator**, click Start

Both panels show live counters. The responder automatically replies to incoming test frames.

#### JSON Reports

The script writes structured results for CI integration:

```bash
python3 scripts/transport_test.py --roundtrip -i can0 --rate 100 --duration 30 \
  --json-report results.json
```

```json
{
  "test_mode": "roundtrip",
  "interface": "can0",
  "canfd": false,
  "duration_sec": 30.0,
  "rate_hz": 100,
  "tx_count": 3000,
  "rx_count": 2998,
  "drops": 2,
  "duplicates": 0,
  "sequence_gaps": [
    { "expected": 1501, "received": 1503 }
  ],
  "latency_us": {
    "min": 142,
    "max": 3821,
    "mean": 487,
    "p50": 423,
    "p95": 1102,
    "p99": 2844
  },
  "errors": [],
  "pass": false
}
```

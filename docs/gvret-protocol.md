# GVRET Binary Serial Protocol

**Protocol source:** [collin80/GVRET](https://github.com/collin80/GVRET) (MIT licence, Collin Kidder, Michael Neuweiler, Charles Galpin)

GVRET (Generalized Electric Vehicle Reverse Engineering Tool) is a firmware for Arduino-based hardware (GEVCU, CANDue, EVTVDue, ESP32-RET, M2RET) that exposes one or more CAN buses over a USB serial or TCP connection using a compact binary protocol. SavvyCAN is the reference client.

WireTAP implements the binary frame streaming subset of GVRET over both USB serial (`gvret_usb`) and TCP (`gvret_tcp`).

---

## 1. General Structure

All packets start with a sync byte (`0xF1`) followed by a command byte. Commands sent from the host to the device use a trailing XOR checksum byte; the checksum is computed over all preceding bytes in the packet. Received data frames (device → host) carry a checksum field that the firmware currently sets to `0x00`.

```
Host → Device:  [0xF1] [CMD] [data...] [XOR checksum]
Device → Host:  [0xF1] [CMD] [data...]  (checksum = 0x00 for frame data)
```

Binary mode must be activated before binary packets are accepted (see §2).

---

## 2. Binary Mode Activation

Send the byte `0xE7` while the device is in its default IDLE/text state. The device switches off LAWICEL text mode and begins accepting and emitting binary packets.

In practice, WireTAP (and SavvyCAN) send the byte twice to ensure receipt:

```
Host → Device:  [0xE7] [0xE7]
```

There is no acknowledgement response.

---

## 3. Command Reference

Command opcodes are defined in `GVRET.h` as a C++ enum (0-based, sequential):

| Opcode | Enum name                | Direction        | Description                          |
|--------|--------------------------|------------------|--------------------------------------|
| `0x00` | `PROTO_BUILD_CAN_FRAME`  | Host → Device    | Transmit a CAN frame                 |
| `0x00` | `PROTO_BUILD_CAN_FRAME`  | Device → Host    | Received CAN frame notification      |
| `0x01` | `PROTO_TIME_SYNC`        | Host → Device    | Request device timestamp             |
| `0x01` | `PROTO_TIME_SYNC`        | Device → Host    | Timestamp response                   |
| `0x02` | `PROTO_DIG_INPUTS`       | Host → Device    | Query digital input states           |
| `0x02` | `PROTO_DIG_INPUTS`       | Device → Host    | Digital input response               |
| `0x03` | `PROTO_ANA_INPUTS`       | Host → Device    | Query analog input values            |
| `0x03` | `PROTO_ANA_INPUTS`       | Device → Host    | Analog input response                |
| `0x04` | `PROTO_SET_DIG_OUT`      | Host → Device    | Set digital output states            |
| `0x05` | `PROTO_SETUP_CANBUS`     | Host → Device    | Configure CAN bus speeds/modes       |
| `0x06` | `PROTO_GET_CANBUS_PARAMS`| Host → Device    | Request current CAN configuration    |
| `0x06` | `PROTO_GET_CANBUS_PARAMS`| Device → Host    | CAN configuration response           |
| `0x07` | `PROTO_GET_DEV_INFO`     | Host → Device    | Request device metadata              |
| `0x07` | `PROTO_GET_DEV_INFO`     | Device → Host    | Device metadata response             |
| `0x08` | `PROTO_SET_SW_MODE`      | Host → Device    | Enable/disable single-wire CAN       |
| `0x09` | `PROTO_KEEPALIVE`        | Device → Host    | Heartbeat / connection validation    |
| `0x0A` | `PROTO_SET_SYSTYPE`      | Host → Device    | Set hardware platform type           |
| `0x0B` | `PROTO_ECHO_CAN_FRAME`   | Host → Device    | Loopback test (echo back to host)    |
| `0x0C` | `PROTO_GET_NUMBUSES`     | Host → Device    | Query number of CAN buses            |
| `0x0C` | `PROTO_GET_NUMBUSES`     | Device → Host    | Bus count response                   |
| `0x0D` | `PROTO_GET_EXT_BUSES`    | Host → Device    | Query extended bus (SWCAN) params    |
| `0x0D` | `PROTO_GET_EXT_BUSES`    | Device → Host    | Extended bus parameter response      |
| `0x0E` | `PROTO_SET_EXT_BUSES`    | Host → Device    | Configure SWCAN and extended buses   |

---

## 4. Packet Formats

### 4.1 Received CAN Frame (Device → Host) — `0x00`

Emitted by the device for every CAN frame received on an active bus:

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0       1     Sync:      0xF1
1       1     Command:   0x00
2–5     4     Timestamp: microseconds since device boot, little-endian uint32
6–9     4     Frame ID:  little-endian uint32; bit 31 set = extended (29-bit) frame
10      1     Bus+DLC:   bits [7:4] = bus number (0-based), bits [3:0] = DLC (0–8)
11–N    0–8   Data:      DLC payload bytes
N+1     1     Checksum:  currently always 0x00
```

**Frame ID encoding:**
- Standard frame (11-bit): `ID & 0x07FF`, bit 31 = 0
- Extended frame (29-bit): `ID & 0x1FFFFFFF`, bit 31 = 1 (`0x80000000`)

**Bus/DLC byte:**
- Lower nibble (`& 0x0F`): DLC (0–8 for classic CAN)
- Upper nibble (`>> 4`): device bus number (0 = CAN0, 1 = CAN1, 2 = SWCAN)

### 4.2 Transmit CAN Frame (Host → Device) — `0x00`

Send a CAN frame out on a specific bus:

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0       1     Sync:      0xF1
1       1     Command:   0x00
2–5     4     Frame ID:  little-endian uint32; bit 31 = extended frame
6       1     Bus:       0 = CAN0, 1 = CAN1, 2 = SWCAN
7       1     Length:    bits [3:0] = number of data bytes (0–8)
8–N     0–8   Data:      payload bytes
N+1     1     Checksum:  XOR of all preceding bytes
```

**Note:** If the frame ID is `0x100` and single-wire mode is active, the device emits a SWCAN wakeup sequence before transmitting.

### 4.3 Time Sync Request/Response — `0x01`

Host request: `[0xF1] [0x01] [checksum]`

Device response:
```
Offset  Size  Description
──────  ────  ──────────────────────────
0       1     0xF1
1       1     0x01
2–5     4     Timestamp: microseconds since boot, little-endian uint32
```
No checksum on the response.

### 4.4 Digital Inputs — `0x02`

Host request: `[0xF1] [0x02] [checksum]`

Device response:
```
Offset  Size  Description
──────  ────  ───────────────────────────────────────────────────────
0       1     0xF1
1       1     0x02
2       1     Pin states: bit 0 = pin 0, bit 1 = pin 1, ... (pins 0–3)
3       1     Checksum
```

### 4.5 Analog Inputs — `0x03`

Host request: `[0xF1] [0x03] [checksum]`

Device response:
```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────
0       1     0xF1
1       1     0x03
2–3     2     Analog 0: little-endian uint16
4–5     2     Analog 1: little-endian uint16
6–7     2     Analog 2: little-endian uint16
8–9     2     Analog 3: little-endian uint16
10      1     Checksum
```

### 4.6 Set Digital Outputs — `0x04`

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0       1     0xF1
1       1     0x04
2       1     Output states: bit N = desired state of output pin N (0–7)
3       1     Checksum
```

No response.

### 4.7 Setup CAN Bus — `0x05`

Configure CAN0 and CAN1 speed and modes. Settings are persisted to EEPROM.

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────────
0       1     0xF1
1       1     0x05
2–5     4     CAN0 config: little-endian uint32
                bit 31: extended status flag (enable bits 30–29 interpretation)
                bit 30: enable CAN0 (when bit 31 set)
                bit 29: listen-only mode (when bit 31 set)
                bits 28–0: bus speed in bps (max 1,000,000)
6–9     4     CAN1 config: same structure as CAN0
10      1     Checksum
```

Maximum speed is clamped to 1,000,000 bps. After this command the device enters promiscuous mode and reloads settings.

### 4.8 Get CAN Bus Parameters — `0x06`

Host request: `[0xF1] [0x06] [checksum]`

Device response (12 bytes total):
```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0       1     0xF1
1       1     0x06
2       1     CAN0 flags: bit 0 = enabled, bit 1 = listen-only
3–6     4     CAN0 speed: little-endian uint32 bps
7       1     CAN1 flags: bit 0 = enabled, bit 1 = listen-only, bit 2 = SWCAN
8–11    4     CAN1 speed: little-endian uint32 bps
```
No trailing checksum on response.

### 4.9 Get Device Info — `0x07`

Host request: `[0xF1] [0x07] [checksum]`

Device response (8 bytes total):
```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────
0       1     0xF1
1       1     0x07
2–3     2     Build number: little-endian uint16
4       1     EEPROM version
5       1     File output type
6       1     Auto-start logging flag
7       1     Single-wire mode enabled flag
```
No trailing checksum on response.

### 4.10 Set Single-Wire Mode — `0x08`

```
Offset  Size  Description
──────  ────  ──────────────────────────────────
0       1     0xF1
1       1     0x08
2       1     Mode: 0x10 = enable, anything else = disable
3       1     Checksum
```

No response.

### 4.11 Keepalive — `0x09`

Sent by the device (unsolicited) as a heartbeat. No host request.

```
Device → Host:  [0xF1] [0x09] [0xDE] [0xAD]
```

### 4.12 Set System Type — `0x0A`

Select the hardware variant. Triggers an EEPROM write and full settings reload.

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────────────
0       1     0xF1
1       1     0x0A
2       1     System type:
                0 = CANDue (default)
                1 = GEVCU
                2 = CANDue v1.3–v2.1
                3 = CANDue v2.2
3       1     Checksum
```

No response.

### 4.13 Echo CAN Frame — `0x0B`

Identical format to Transmit CAN Frame (§4.2) but the device returns the frame to the host instead of transmitting it to the bus. Used for loopback testing.

### 4.14 Get Number of Buses — `0x0C`

Host request: `[0xF1] [0x0C] [checksum]`

Device response (3 bytes total):
```
Offset  Size  Description
──────  ────  ─────────────────────────────
0       1     0xF1
1       1     0x0C
2       1     Bus count (fixed at 0x03: CAN0, CAN1, SWCAN)
```

### 4.15 Get Extended Buses — `0x0D`

Host request: `[0xF1] [0x0D] [checksum]`

Device response:
```
Offset  Size  Description
──────  ────  ───────────────────────────────────────────────────
0       1     0xF1
1       1     0x0D
2       1     SWCAN flags: bit 0 = enabled, bit 1 = listen-only
3–6     4     SWCAN speed: little-endian uint32 bps
7       1     Bus 4 enabled (reserved, unused)
8–11    4     Bus 4 speed (reserved, unused)
12      1     Bus 5 enabled (reserved, unused)
13–16   4     Bus 5 speed (reserved, unused)
```

### 4.16 Set Extended Buses — `0x0E`

Configure SWCAN and future extended buses. Maximum SWCAN speed is 100,000 bps.

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────────
0       1     0xF1
1       1     0x0E
2–5     4     SWCAN config: little-endian uint32
                bit 31: extended status flag
                bit 30: enable SWCAN
                bit 29: listen-only mode
                bits 28–0: speed in bps (max 100,000)
6–9     4     Bus 4 config (reserved, unused)
10–13   4     Bus 5 config (reserved, unused)
14      1     Checksum
```

---

## 5. Checksums

The XOR checksum is computed over all bytes in the packet preceding the checksum byte itself, including the `0xF1` sync byte and command byte.

```
checksum = 0xF1 ^ CMD ^ data[0] ^ data[1] ^ ... ^ data[N-1]
```

The device validates the checksum on all incoming packets. Received frame packets (device → host) carry a checksum field that the firmware always sets to `0x00` and clients are not expected to validate.

---

## 6. State Machine

The firmware operates a byte-level state machine. States relevant to the binary protocol:

| State                | Meaning                                    |
|----------------------|--------------------------------------------|
| `IDLE`               | Awaiting 0xF1 or 0xE7                      |
| `GET_COMMAND`        | Reading command byte after 0xF1            |
| `BUILD_CAN_FRAME`    | Accumulating transmit frame bytes          |
| `TIME_SYNC`          | Awaiting time sync request                 |
| `SET_DIG_OUTPUTS`    | Awaiting output byte                       |
| `SETUP_CANBUS`       | Accumulating bus config bytes              |
| `SET_SINGLEWIRE_MODE`| Awaiting mode byte                         |
| `SET_SYSTYPE`        | Awaiting system type byte                  |
| `ECHO_CAN_FRAME`     | Accumulating echo frame bytes              |
| `SETUP_EXT_BUSES`    | Accumulating extended bus config bytes     |

---

## 7. WireTAP Implementation

### 7.1 What WireTAP Implements

WireTAP implements the binary frame streaming subset sufficient for passive monitoring and frame transmission. The driver is in `src-tauri/src/io/gvret/`.

| Feature | Status | Notes |
|---------|--------|-------|
| Binary mode activation (`0xE7 0xE7`) | ✅ Implemented | Sent on connect (USB and TCP) |
| Received CAN frame parsing (`0x00`) | ✅ Implemented | `parse_gvret_frames()` in `common.rs` |
| Transmit CAN frame encoding (`0x00`) | ✅ Implemented | `encode_gvret_frame()` in `common.rs` |
| Standard (11-bit) frame IDs | ✅ Implemented | Mask `0x07FF` applied |
| Extended (29-bit) frame IDs | ✅ Implemented | Bit 31 flag detected and stripped |
| Multi-bus (bus number from DLC byte) | ✅ Implemented | Upper nibble of bus+DLC byte |
| USB serial transport | ✅ Implemented | `gvret_usb` using `serialport` crate |
| TCP transport | ✅ Implemented | `gvret_tcp` using Tokio |
| Device probing — `PROTO_GET_NUMBUSES` (`0x0C`) | ✅ Implemented | Sent on connect; response determines bus count |
| Device info probe — `PROTO_GET_DEV_INFO` (`0x07`) | ✅ Sent | Response consumed and discarded in streaming path |
| CAN FD DLC codes (DLC 9–15) | ✅ Extended | Not in upstream protocol; WireTAP extends DLC mapping using the standard FD DLC table |
| Keepalive response (`0x09`) | ✅ Silently consumed | Skipped in frame parser; not sent proactively |
| Time sync response (`0x01`) | ✅ Silently consumed | Skipped in frame parser; host clock used for timestamps instead |
| CAN params response (`0x06`) | ✅ Silently consumed | Skipped in frame parser |
| Bus mapping | ✅ WireTAP-specific | Device bus numbers remapped to output bus numbers via `BusMapping` config |

### 7.2 What WireTAP Does Not Implement

| Feature | Opcode | Reason |
|---------|--------|--------|
| Time sync request | `0x01` | Host clock used for all timestamps; device time discarded |
| Digital input query | `0x02` | Hardware I/O not exposed through WireTAP |
| Analog input query | `0x03` | Hardware I/O not exposed through WireTAP |
| Set digital outputs | `0x04` | Hardware I/O not exposed through WireTAP |
| CAN bus speed/mode configuration | `0x05` | Device used in its pre-configured state; WireTAP does not modify hardware settings |
| Get CAN bus params | `0x06` | Response consumed but not surfaced; bus config managed on the device directly |
| Single-wire CAN mode | `0x08` | SWCAN not currently surfaced in WireTAP |
| Set system type | `0x0A` | Not required for passive use |
| Echo CAN frame | `0x0B` | Loopback testing not implemented |
| Get/Set extended buses | `0x0D`, `0x0E` | SWCAN configuration not surfaced |
| Checksums on transmit | — | WireTAP omits the trailing XOR checksum byte when sending frames; in practice devices tolerate this |

### 7.3 Deviations from Upstream

**Timestamps:** The upstream protocol delivers a device-side microsecond timestamp in every received frame (bytes 2–5). WireTAP discards the device timestamp and substitutes the host wall-clock time via `now_us()`. This avoids clock drift issues when a device has not been synchronised, but means relative timing between frames is limited by host scheduling jitter rather than the hardware timer.

**Checksums not sent:** WireTAP does not append the XOR checksum byte when encoding transmit frames (`encode_gvret_frame`). GVRET-compatible devices have been observed to accept frames without checksum validation.

**CAN FD payload lengths:** The upstream GVRET protocol only defines DLC 0–8 for classic CAN. WireTAP maps DLC nibble values 9–15 to the standard CAN FD payload sizes (12, 16, 20, 24, 32, 48, 64 bytes) using the `DLC_LEN` table, enabling CAN FD frame capture from devices that support it.

**TCP transport:** The original GVRET protocol runs over USB CDC serial. WireTAP also supports it over TCP (as does SavvyCAN). The binary protocol is identical; the transport is simply a TCP stream.

**Bus count default:** If a device does not respond to `PROTO_GET_NUMBUSES` within the probe timeout, WireTAP defaults to 1 bus (USB) or 1 bus (TCP). The upstream firmware always returns 3 (CAN0, CAN1, SWCAN).

### 7.4 Relevant Source Files

| File | Purpose |
|------|---------|
| `src-tauri/src/io/gvret/mod.rs` | Module root; public re-exports |
| `src-tauri/src/io/gvret/common.rs` | Protocol constants, frame parser, encoder, bus mapping |
| `src-tauri/src/io/gvret/codec.rs` | `GvretCodec` implementing the `FrameCodec` trait |
| `src-tauri/src/io/gvret/tcp.rs` | TCP transport: probing and streaming |
| `src-tauri/src/io/gvret/usb.rs` | USB serial transport: probing and streaming |

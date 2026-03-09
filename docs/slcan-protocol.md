# SLCAN (Serial Line CAN) Protocol

**Protocol source:** [Lawicel CAN232 (v3)](http://www.can232.com/docs/can232_v3.pdf)
**CAN FD extension:** [Elmue CANable 2.5 firmware](https://github.com/Elmue/CANable-2.5-firmware-Slcan-and-Candlelight)

SLCAN is a simple ASCII protocol for exchanging CAN frames over a serial (USB CDC) connection. It was originally defined by Lawicel for the CAN232 adapter and is now used by CANable, CANable Pro, and many other USB-CAN adapters. The Elmue CANable 2.5 firmware extends SLCAN with CAN FD frame types and data-phase bitrate commands.

WireTAP implements the full SLCAN protocol including the Elmue CAN FD extensions.

---

## 1. General Structure

All commands and frames are ASCII strings terminated by a carriage return (`\r`). The device responds with `\r` on success or bell (`0x07`) on error. Frames flow in both directions using the same format.

```
Host -> Device:  <command>\r
Device -> Host:  <response>\r  or  \x07 (error)

Frame RX/TX:     <prefix><id><dlc><data>\r
```

---

## 2. Command Reference

### 2.1 Configuration Commands

| Command | Description | Notes |
|---------|-------------|-------|
| `S0`-`S8` | Set nominal (arbitration) bitrate | See bitrate table below |
| `Y0`-`Y8` | Set CAN FD data phase bitrate | Elmue extension; implicitly enables FD mode |
| `s<P>,<S1>,<S2>,<SJW>` | Set custom nominal bitrate | Prescaler, Segment1, Segment2, SJW |
| `y<P>,<S1>,<S2>,<SJW>` | Set custom FD data bitrate | Elmue extension; recommended for CAN FD |
| `M0` | Normal mode (active) | Participates in bus arbitration, sends ACKs |
| `M1` | Silent mode (monitor) | No ACK, no transmit, passive observation only |
| `O` | Open channel | Begins frame reception/transmission |
| `C` | Close channel | Stops all activity, resets bitrate settings |

### 2.2 Query Commands

| Command | Response | Description |
|---------|----------|-------------|
| `V` | `V<version>` | Firmware version (standard: `V1013`, Elmue: extended multi-field) |
| `v` | `v<version>` | Hardware version (optional, some devices only) |
| `N` | `N<serial>` | Device serial number (optional) |

### 2.3 Nominal Bitrate Codes (S commands)

| Code | Bitrate |
|------|---------|
| S0 | 10 Kbit/s |
| S1 | 20 Kbit/s |
| S2 | 50 Kbit/s |
| S3 | 100 Kbit/s |
| S4 | 125 Kbit/s |
| S5 | 250 Kbit/s |
| S6 | 500 Kbit/s |
| S7 | 750 Kbit/s |
| S8 | 1 Mbit/s |

### 2.4 CAN FD Data Phase Bitrate Codes (Y commands, Elmue extension)

| Code | Bitrate |
|------|---------|
| Y0 | 500 Kbit/s |
| Y1 | 1 Mbit/s |
| Y2 | 2 Mbit/s |
| Y4 | 4 Mbit/s |
| Y5 | 5 Mbit/s |
| Y8 | 8 Mbit/s |

---

## 3. Frame Formats

### 3.1 Classic CAN

**Standard frame (11-bit ID):**
```
t<ID:3hex><DLC:1hex><DATA:2hex*DLC>\r
Example: t1234AABBCCDD\r
  ID=0x123, DLC=4, data=[0xAA,0xBB,0xCC,0xDD]
```

**Extended frame (29-bit ID):**
```
T<ID:8hex><DLC:1hex><DATA:2hex*DLC>\r
Example: T123456788AABBCCDDEEFF0011\r
  ID=0x12345678, DLC=8
```

**Standard RTR:**
```
r<ID:3hex><DLC:1hex>\r
Example: r1234\r
  No data bytes.
```

**Extended RTR:**
```
R<ID:8hex><DLC:1hex>\r
```

### 3.2 CAN FD (Elmue Extension)

CAN FD frames use four additional prefixes:

| Prefix | ID type | BRS | Description |
|--------|---------|-----|-------------|
| `d` | Standard (11-bit) | No | FD frame, single data rate |
| `D` | Extended (29-bit) | No | FD frame, single data rate |
| `b` | Standard (11-bit) | Yes | FD frame with bit rate switch |
| `B` | Extended (29-bit) | Yes | FD frame with bit rate switch |

**Format (same structure as classic, but with FD DLC codes):**
```
<prefix><ID><DLC:1hex><DATA:2hex*len>\r
Example: d7E09112233445566778899AABBCC\r
  FD standard, ID=0x7E0, DLC=9 (12 bytes), data=[0x11,...,0xCC]
```

### 3.3 CAN FD DLC Mapping (ISO 11898-2:2015)

DLC codes 0-8 map directly to byte count. Codes 9-F map to larger payloads:

| DLC code | Byte count |
|----------|------------|
| 0-8 | 0-8 (direct) |
| 9 | 12 |
| A | 16 |
| B | 20 |
| C | 24 |
| D | 32 |
| E | 48 |
| F | 64 |

---

## 4. Initialisation Sequence

WireTAP sends the following commands when connecting to an SLCAN device:

```
1. Clear serial buffers
   (wait 200ms for USB device to stabilise)

2. C\r              Close any existing channel
   (wait 50ms)

3. S6\r             Set nominal bitrate (e.g. S6 = 500 Kbit/s)
   (wait 50ms)

4. Y2\r             Set FD data bitrate (only if enable_fd = true)
   (wait 50ms)       e.g. Y2 = 2 Mbit/s

5. M0\r  or  M1\r   Set mode (M0 = normal, M1 = silent)
   (wait 50ms)

6. O\r              Open channel — frames begin flowing
```

On disconnect, WireTAP sends `C\r` to close the channel.

---

## 5. Device Probing

WireTAP probes SLCAN devices before creating a session to verify connectivity and detect capabilities.

**Probe sequence:**
1. Open serial port (500ms timeout)
2. Wait 200ms for USB stabilisation
3. Clear buffers, send `C\r` to reset
4. Send `V\r` — firmware version query
5. Send `v\r` — hardware version query (skipped if V already provided hardware info)
6. Send `N\r` — serial number query
7. Close port

**Elmue firmware detection:**

Standard SLCAN firmware returns a short version string (e.g. `V1013`). The Elmue CANable 2.5 firmware returns an extended response containing structured fields:

```
V+Board: MultiboardMCU: STM32G431DevID: 1128Firmware: 2490643Slcan: 100Clock: 160Limits: 512,256,128,128,32,32,16,16
```

WireTAP parses this to extract:
- **Firmware version** from the `Firmware:` field
- **Board type and MCU** from the `Board:` and `MCU:` fields (e.g. "Multiboard STM32G431")
- **CAN FD support** — presence of the extended format indicates Elmue firmware, which supports CAN FD

Standard firmware versions formatted as 4 digits (e.g. `1013`) are displayed as `1.0.13`.

---

## 6. Error Handling

- **Bell character (`0x07`):** Sent by device to indicate a command error. WireTAP discards the current line buffer on receipt.
- **Invalid frames:** Malformed lines (bad hex, wrong length, unknown prefix) are silently skipped.
- **Line buffer overflow:** Lines exceeding 512 bytes are discarded. This accommodates CAN FD frames (up to ~139 chars) and Elmue extended version responses (~200 chars).

---

## 7. WireTAP Implementation

### 7.1 What WireTAP Implements

| Feature | Status | Notes |
|---------|--------|-------|
| Classic CAN frame RX (t, T) | Implemented | Standard and extended IDs |
| Classic CAN frame TX (t, T) | Implemented | Normal mode only (not in silent mode) |
| RTR frame RX (r, R) | Implemented | Standard and extended |
| CAN FD frame RX (d, D, b, B) | Implemented | Elmue firmware extension |
| CAN FD frame TX (d, D, b, B) | Implemented | With BRS flag support |
| Nominal bitrate (S0-S8) | Implemented | Mapped from profile bitrate setting |
| FD data bitrate (Y0-Y8) | Implemented | Sent when `enable_fd = true` |
| Silent mode (M0/M1) | Implemented | M1 disables transmit channel entirely |
| Device probe (V, v, N) | Implemented | Auto-probes on port selection in settings |
| Elmue firmware detection | Implemented | Extended V response parsing |
| CAN FD capability detection | Implemented | Based on Elmue firmware identification |
| Bus mapping | Implemented | Shared with GVRET; supports multi-device sessions |
| Bell error handling | Implemented | Discards current line |
| Transmit result feedback | Implemented | Caller receives write success/error via channel |

### 7.2 What WireTAP Does Not Implement

| Feature | Reason |
|---------|--------|
| RTR frame TX | Not required for WireTAP's use cases |
| Custom bitrate (s/y commands) | Only preset S/Y codes used; custom timing not exposed in UI |
| Hardware timestamps | Device timestamps not available in standard SLCAN; host clock used |
| CAN filter configuration | Full promiscuous mode; filtering done in software |
| Status register queries | Not part of standard SLCAN protocol |
| Loopback/echo testing | Not required for production use |

### 7.3 Deviations from Standard

**Timestamps:** Standard SLCAN does not define timestamps in frame responses. WireTAP assigns host wall-clock time (`now_us()`) to each received frame. Relative timing between frames is limited by host scheduling jitter.

**No hardware configuration:** WireTAP does not modify device hardware settings beyond bitrate and mode. The device is expected to be pre-configured or use defaults.

**CAN FD as firmware extension:** CAN FD frame types (d, D, b, B) and Y bitrate commands are not part of the original Lawicel SLCAN specification. They are an extension defined by the Elmue CANable 2.5 firmware. WireTAP supports them when the Elmue firmware is detected.

### 7.4 Relevant Source Files

| File | Purpose |
|------|---------|
| `src-tauri/src/io/slcan/mod.rs` | Module root; public re-exports |
| `src-tauri/src/io/slcan/codec.rs` | `SlcanCodec` implementing the `FrameCodec` trait; frame encode/decode |
| `src-tauri/src/io/slcan/reader.rs` | Device init, probing, streaming read loop, transmit, frame parsing |
| `src-tauri/src/io/codec.rs` | `FrameCodec` trait definition |
| `src-tauri/src/io/multi_source/spawner.rs` | Session integration; profile → config mapping |

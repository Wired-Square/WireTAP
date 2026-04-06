# gs_usb (candleLight) USB Protocol

**Protocol source:** [Linux kernel gs_usb driver](https://github.com/torvalds/linux/blob/master/drivers/net/can/usb/gs_usb.c) (GPL-2.0, Maximilian Schneider)

gs_usb is a USB protocol for CAN bus adapters, defined by the Linux kernel driver for the Geschwister Schneider USB/CAN device. Compatible firmware implementations (such as candleLight for STM32 microcontrollers) make devices like the CANable and CANable Pro appear as gs_usb adapters. On Linux, the kernel driver exposes them as SocketCAN interfaces. On Windows and macOS, no kernel driver exists, so WireTAP accesses the USB device directly.

WireTAP implements gs_usb on all platforms: via SocketCAN on Linux, and via direct USB access (nusb crate) on Windows and macOS.

---

## 1. General Structure

gs_usb uses USB control transfers (EP0) for configuration and bulk transfers (EP1 IN / EP2 OUT) for CAN frame data. All multi-byte fields are little-endian. There are no ASCII commands or checksums — the protocol is entirely binary and relies on USB transport integrity.

```
Configuration:    USB Control Transfer (EP0)
Frame RX:         USB Bulk IN  (EP1, 0x81)
Frame TX:         USB Bulk OUT (EP2, 0x02)
```

---

## 2. USB Identification

gs_usb devices use the OpenMoko Vendor ID:

| Field | Value | Description |
|-------|-------|-------------|
| VID | `0x1D50` | OpenMoko Inc. |
| PID | `0x606F` | Geschwister Schneider USB/CAN, candleLight |
| PID | `0x606D` | CANable (candleLight firmware) |

---

## 3. Control Requests

All control transfers use vendor-type requests to the interface recipient. The `wValue` field typically carries the CAN channel index (0-based). The `wIndex` field is 0 unless otherwise noted.

### 3.1 Request Types

| Request | Code | Direction | Payload | Description |
|---------|------|-----------|---------|-------------|
| HOST_FORMAT | 0 | OUT | 4 bytes | Byte order negotiation (must be `0x0000BEEF` LE) |
| BITTIMING | 1 | OUT | 20 bytes | Set nominal (arbitration) bit timing |
| MODE | 2 | OUT | 8 bytes | Start/stop device, set operating mode |
| BERR | 3 | IN | — | Bus error reporting |
| BT_CONST | 4 | IN | 40 bytes | Query bit timing constants and feature flags |
| DEVICE_CONFIG | 5 | IN | 12 bytes | Query device configuration (channel count, versions) |
| TIMESTAMP | 6 | IN | — | Hardware timestamp |
| IDENTIFY | 7 | OUT | — | Blink LED for device identification |
| GET_USER_ID | 8 | IN | — | Read user-defined device ID |
| SET_USER_ID | 9 | OUT | — | Write user-defined device ID |
| DATA_BITTIMING | 10 | OUT | 20 bytes | Set CAN FD data phase bit timing |
| BT_CONST_EXT | 11 | IN | 72 bytes | Extended bit timing constants (nominal + data phase) |
| SET_TERMINATION | 12 | OUT | — | Enable/disable bus termination resistor |
| GET_TERMINATION | 13 | IN | — | Query termination resistor state |
| GET_STATE | 14 | IN | — | Query CAN controller state |

### 3.2 HOST_FORMAT (Request 0)

Sent first during initialisation to negotiate byte order. The payload is always `0x0000BEEF` in little-endian.

```
wValue: 1
wIndex: channel
Data:   [0xEF, 0xBE, 0x00, 0x00]
```

### 3.3 DEVICE_CONFIG (Request 5)

Returns device metadata:

```
Offset  Size  Description
──────  ────  ──────────────────────────────
0       1     Reserved
1       1     Reserved
2       1     Reserved
3       1     icount: number of CAN interfaces minus 1 (0 = 1 channel, 1 = 2 channels)
4–7     4     Software version (little-endian uint32)
8–11    4     Hardware version (little-endian uint32)
```

### 3.4 BT_CONST (Request 4)

Returns bit timing constants and feature flags for the specified channel (40 bytes):

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────
0–3     4     Feature flags (see feature flags table)
4–7     4     CAN clock frequency (Hz), e.g. 48000000
8–11    4     tseg1_min
12–15   4     tseg1_max
16–19   4     tseg2_min
20–23   4     tseg2_max
24–27   4     sjw_max
28–31   4     brp_min
32–35   4     brp_max
36–39   4     brp_inc
```

### 3.5 BT_CONST_EXT (Request 11)

Extended version of BT_CONST (72 bytes) that includes both nominal and data phase constraints. Only available on devices that advertise the `BT_CONST_EXT` feature flag.

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────
0–39    40    Nominal phase (same layout as BT_CONST)
40–43   4     dtseg1_min  (data phase)
44–47   4     dtseg1_max
48–51   4     dtseg2_min
52–55   4     dtseg2_max
56–59   4     dsjw_max
60–63   4     dbrp_min
64–67   4     dbrp_max
68–71   4     dbrp_inc
```

### 3.6 Feature Flags

Feature flags from the BT_CONST `feature` field:

| Bit | Value | Name | Description |
|-----|-------|------|-------------|
| 0 | `0x001` | LISTEN_ONLY | Supports listen-only (silent) mode |
| 1 | `0x002` | LOOP_BACK | Supports loopback mode |
| 2 | `0x004` | TRIPLE_SAMPLE | Supports triple sampling |
| 3 | `0x008` | ONE_SHOT | Supports one-shot transmit mode |
| 4 | `0x010` | HW_TIMESTAMP | Supports hardware timestamps |
| 5 | `0x020` | IDENTIFY | Supports LED identification |
| 6 | `0x040` | USER_ID | Supports user-defined device ID |
| 7 | `0x080` | PAD_PKTS_TO_MAX_PKT_SIZE | Pads USB packets to max packet boundary |
| 8 | `0x100` | FD | Supports CAN FD |
| 9 | `0x200` | REQ_USB_QUIRK_LPC546XX | LPC546xx USB quirk workaround |
| 10 | `0x400` | BT_CONST_EXT | Supports extended BT_CONST (72-byte response) |
| 11 | `0x800` | TERMINATION | Supports bus termination control |
| 12 | `0x1000` | BERR_REPORTING | Supports bus error reporting |
| 13 | `0x2000` | GET_STATE | Supports CAN controller state query |

### 3.7 BITTIMING (Request 1)

Sets the nominal (arbitration phase) bit timing for a channel. The timing structure is 20 bytes:

```
Offset  Size  Description
──────  ────  ──────────────────────────────
0–3     4     prop_seg (propagation segment)
4–7     4     phase_seg1
8–11    4     phase_seg2
12–15   4     sjw (synchronisation jump width)
16–19   4     brp (baud rate prescaler)
```

**Bitrate formula:**
```
bitrate = fclk_can / (brp × (1 + prop_seg + phase_seg1 + phase_seg2))
```

**Sample point:**
```
sample_point = (1 + prop_seg + phase_seg1) / (1 + prop_seg + phase_seg1 + phase_seg2)
```

### 3.8 DATA_BITTIMING (Request 10)

Sets the CAN FD data phase bit timing. Same 20-byte structure as BITTIMING (§3.7). Only used when CAN FD mode is enabled.

### 3.9 MODE (Request 2)

Starts or stops the CAN controller. Payload is 8 bytes:

```
Offset  Size  Description
──────  ────  ──────────────────────────────
0–3     4     Mode: 0 = reset/stop, 1 = start
4–7     4     Mode flags (bitfield)
```

**Mode flags:**

| Bit | Value | Name | Description |
|-----|-------|------|-------------|
| 0 | `0x001` | LISTEN_ONLY | No ACK, no transmit |
| 1 | `0x002` | LOOP_BACK | Internal loopback |
| 2 | `0x004` | TRIPLE_SAMPLE | Triple sampling |
| 3 | `0x008` | ONE_SHOT | No automatic retransmission |
| 4 | `0x010` | HW_TIMESTAMP | Enable hardware timestamps in frames |
| 7 | `0x080` | PAD_PKTS_TO_MAX_PKT_SIZE | Pad bulk transfers to USB packet boundary |
| 8 | `0x100` | FD | Enable CAN FD mode |

---

## 4. Frame Formats

### 4.1 Classic CAN Host Frame (20 bytes)

Used for both RX (Bulk IN) and TX (Bulk OUT):

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0–3     4     echo_id: 0xFFFFFFFF = RX frame, any other value = TX/echo
4–7     4     can_id: CAN identifier with flag bits (see below)
8       1     can_dlc: data length code (0–8)
9       1     channel: CAN channel index (0-based)
10      1     flags: frame flags (FD/BRS/ESI, see below)
11      1     reserved (0x00)
12–19   8     data: CAN payload (up to 8 bytes, zero-padded)
```

### 4.2 CAN FD Host Frame (76 bytes)

Used for CAN FD frames with payloads up to 64 bytes:

```
Offset  Size  Description
──────  ────  ──────────────────────────────────────────────────────────────
0–3     4     echo_id: 0xFFFFFFFF = RX frame, any other value = TX/echo
4–7     4     can_id: CAN identifier with flag bits
8       1     can_dlc: DLC code (0–15, maps to 0–64 bytes via FD table)
9       1     channel: CAN channel index (0-based)
10      1     flags: FD frame flags
11      1     reserved (0x00)
12–75   64    data: CAN FD payload (up to 64 bytes, zero-padded)
```

### 4.3 CAN ID Encoding

The `can_id` field contains the CAN identifier in the lower bits, with flag bits in the upper bits:

| Bit(s) | Mask | Description |
|--------|------|-------------|
| 31 | `0x80000000` | Extended frame flag (29-bit ID) |
| 30 | `0x40000000` | RTR (Remote Transmission Request) flag |
| 29 | `0x20000000` | Error frame flag |
| 28–0 | `0x1FFFFFFF` | CAN ID (11-bit standard or 29-bit extended) |

### 4.4 Frame Flags

The `flags` byte in the host frame:

| Bit | Value | Name | Description |
|-----|-------|------|-------------|
| 0 | `0x01` | FD | CAN FD frame |
| 1 | `0x02` | BRS | Bit Rate Switch (data phase uses higher bitrate) |
| 2 | `0x04` | ESI | Error State Indicator |

### 4.5 Echo ID

The `echo_id` field distinguishes received frames from TX echoes:

- **`0xFFFFFFFF`**: Frame received from the bus (RX)
- **Any other value**: TX echo — the device returns the frame after successful transmission, with the same `echo_id` the host assigned. Used for TX confirmation.

### 4.6 CAN FD DLC Mapping (ISO 11898-2:2015)

DLC codes 0–8 map directly to byte count. Codes 9–15 map to larger payloads:

| DLC code | Byte count |
|----------|------------|
| 0–8 | 0–8 (direct) |
| 9 | 12 |
| 10 | 16 |
| 11 | 20 |
| 12 | 24 |
| 13 | 32 |
| 14 | 48 |
| 15 | 64 |

### 4.7 Packet Padding

Devices that advertise the `PAD_PKTS_TO_MAX_PKT_SIZE` feature flag pad bulk transfers to the USB maximum packet size boundary. The maximum packet size is **not static** — it is read from the bulk IN endpoint descriptor in the device's USB topology. Common values are 32 bytes (full-speed) or 512 bytes (high-speed), but the actual value depends on the device.

When padding is enabled, frames are padded to the endpoint's max packet size. When padding is disabled, frames are their native size (20 bytes for classic CAN, 76 bytes for CAN FD).

WireTAP discovers the max packet size via `discover_bulk_endpoints()`, which reads the endpoint descriptor. If the descriptor cannot be read, it falls back to 32 bytes. Read buffers are sized to the discovered max packet size, and the frame stride (used to parse multi-frame transfers) is set to either the max packet size (padded) or the native frame size (unpadded).

---

## 5. Initialisation Sequence

WireTAP sends the following control requests when starting a gs_usb session (Windows/macOS direct USB path):

```
1. HOST_FORMAT          Byte order negotiation (0x0000BEEF)
2. BT_CONST             Query feature flags, clock, and timing constraints
3. MODE (reset)         Reset device (mode=0, flags=0)
4. BITTIMING            Set nominal bit timing (calculated from bitrate + sample point)
5. BT_CONST_EXT         Query FD data phase constraints (only if FD enabled and device supports it)
6. DATA_BITTIMING       Set FD data phase timing (only if FD enabled)
7. MODE (start)         Start CAN controller (mode=1, flags=mode_flags)
```

On stop, WireTAP sends MODE with `mode=0` (reset/stop).

### 5.1 Bit Timing Calculation

WireTAP calculates bit timing parameters from the desired bitrate and sample point:

1. **Query device clock** from BT_CONST response (`fclk_can` field)
2. **Try multiple TQ counts** (25, 20, 16, 12, 10, 8, 6, 5, 4 time quanta per bit)
3. **Calculate BRP** = `fclk_can / (bitrate × TQ_per_bit)`
4. **Validate against device constraints** (tseg1/tseg2 min/max, brp min/max/inc)
5. **Verify bitrate accuracy** (within 1% tolerance)
6. **Fall back to pre-calculated table** if constrained calculation fails (assumes 48 MHz clock)

Common sample points: 87.5% (nominal), 75.0% (FD data phase).

---

## 6. Platform Strategy

### 6.1 Linux

On Linux, the kernel's `gs_usb` driver claims the device and exposes it as a SocketCAN interface (e.g., `can0`). WireTAP:

1. Enumerates gs_usb devices by scanning `/sys/class/net/` for CAN interfaces whose parent USB device matches the gs_usb VID/PID
2. Also scans `/sys/bus/usb/devices/` for unbound devices (connected but no CAN interface yet)
3. Reads from the SocketCAN interface using the existing SocketCAN reader (not the nusb driver)
4. Generates an `ip link set` command for the user to configure the interface with `sudo`

### 6.2 Windows and macOS

No kernel driver is available. WireTAP accesses the USB device directly via the `nusb` crate:

1. Enumerates devices by VID/PID using `nusb::list_devices()`
2. Opens the device and claims USB interface 0
3. Sends control transfers for configuration
4. Reads frames from Bulk IN endpoint (0x81) with pre-submitted read requests for throughput
5. Writes frames to Bulk OUT endpoint (0x02) via a dedicated transmit task

---

## 7. Device Probing

WireTAP probes gs_usb devices before creating a session to verify connectivity and detect capabilities.

**Probe sequence (Windows/macOS):**
1. Find device by serial number (preferred) or USB bus:address (fallback)
2. Open device, claim interface 0
3. Send DEVICE_CONFIG request → extract channel count, software/hardware versions
4. Send BT_CONST request → extract feature flags and CAN clock frequency
5. Check FD feature flag to determine CAN FD support
6. Close device

**Device matching:** WireTAP prefers USB serial number for device identification (stable across USB re-enumeration) and falls back to bus:address matching when serial is unavailable.

---

## 8. WireTAP Implementation

### 8.1 What WireTAP Implements

| Feature | Status | Notes |
|---------|--------|-------|
| Device enumeration | Implemented | VID/PID scan via nusb (Win/macOS) or sysfs (Linux) |
| Device probing (DEVICE_CONFIG, BT_CONST) | Implemented | Channel count, versions, FD capability detection |
| Byte order negotiation (HOST_FORMAT) | Implemented | Sent during initialisation |
| Nominal bit timing (BITTIMING) | Implemented | Calculated from bitrate, sample point, and device constraints |
| FD data bit timing (DATA_BITTIMING) | Implemented | Using BT_CONST_EXT constraints when available |
| Extended bit timing constants (BT_CONST_EXT) | Implemented | Queried when FD enabled and device supports it |
| Mode control (start/stop/reset) | Implemented | Normal and listen-only modes |
| CAN FD mode flag | Implemented | Enabled via MODE flags when `enable_fd = true` |
| Packet padding | Implemented | Enabled when device advertises PAD_PKTS_TO_MAX_PKT_SIZE |
| Classic CAN frame RX | Implemented | 20-byte GsHostFrame via Bulk IN |
| CAN FD frame RX | Implemented | 76-byte GsHostFrameFd via Bulk IN |
| Classic CAN frame TX | Implemented | Via dedicated transmit task on Bulk OUT |
| CAN FD frame TX | Implemented | 76-byte encoding with FD/BRS flags |
| Standard (11-bit) frame IDs | Implemented | Mask `0x1FFFFFFF` applied |
| Extended (29-bit) frame IDs | Implemented | Bit 31 flag detected and stripped |
| Multi-channel support | Implemented | Channel field in config; bus_override for multi-device sessions |
| Serial number matching | Implemented | Stable device identification across USB re-enumeration |
| Bus mapping | Implemented | Shared with GVRET; supports multi-device sessions |
| Transmit result feedback | Implemented | Caller receives write success/error via channel |
| Linux SocketCAN fallback | Implemented | Uses kernel gs_usb driver + SocketCAN reader |

### 8.2 What WireTAP Does Not Implement

| Feature | Request | Reason |
|---------|---------|--------|
| Hardware timestamps | TIMESTAMP (6) | Host clock used for all timestamps |
| Bus error reporting | BERR (3) | Not required for WireTAP's use cases |
| LED identification | IDENTIFY (7) | Not exposed in UI |
| User ID read/write | GET/SET_USER_ID (8/9) | Not required |
| Bus termination control | SET/GET_TERMINATION (12/13) | Not exposed in UI |
| CAN controller state query | GET_STATE (14) | Not exposed in UI |
| Loopback mode | MODE flag | Not required for production use |
| Triple sampling | MODE flag | Not required for production use |
| TX echo handling | — | TX echoes are silently discarded (echo_id ≠ 0xFFFFFFFF) |

### 8.3 Deviations from Linux Kernel Driver

**Timestamps:** The Linux gs_usb driver can use hardware timestamps when the device supports them (HW_TIMESTAMP feature). WireTAP always uses host wall-clock time via `now_us()`. Relative timing between frames is limited by host scheduling jitter.

**FD detection heuristic:** Some firmware versions do not set the FD flag on received frames. WireTAP detects FD frames by checking both the flags byte and DLC > 8 when FD mode is enabled.

**Bit timing fallback:** WireTAP carries a pre-calculated timing table for common bitrates assuming a 48 MHz clock (STM32F042). If constrained calculation fails, it falls back to this table. The Linux kernel driver relies entirely on device-reported constraints.

**No TX echo tracking:** The Linux kernel driver uses echo IDs to track in-flight transmissions and provide TX completion callbacks. WireTAP discards all non-RX frames and uses a simpler synchronous transmit-and-wait model.

### 8.4 Relevant Source Files

| File | Purpose |
|------|---------|
| `src-tauri/src/io/gs_usb/mod.rs` | Module root; protocol constants, structures, bitrate calculation, Tauri commands |
| `src-tauri/src/io/gs_usb/nusb_driver.rs` | Direct USB driver (Windows/macOS); device init, streaming, transmit |
| `src-tauri/src/io/gs_usb/codec.rs` | `GsUsbCodec` implementing the `FrameCodec` trait (classic CAN only) |
| `src-tauri/src/io/gs_usb/linux.rs` | Linux device enumeration via sysfs; maps to SocketCAN interfaces |
| `src-tauri/src/io/codec.rs` | `FrameCodec` trait definition |
| `src-tauri/src/io/broker/spawner.rs` | Session integration; profile → config mapping |

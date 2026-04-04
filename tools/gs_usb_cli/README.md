# gs_usb_cli

A diagnostic CLI for gs_usb/candleLight CAN adapters. Bypasses the WireTAP Tauri/UI stack to give direct control over USB transfers for diagnosing frame loss and protocol issues.

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | Supported | Via nusb (userspace USB) |
| Windows | Supported | Via nusb (userspace USB) |
| Linux | Not applicable | gs_usb devices appear as native SocketCAN interfaces; use `candump`/`cansend` from can-utils |

## Building

`gs_usb_cli` is not built as part of the standard WireTAP build. Build it separately with the `cli` feature flag:

```bash
cd src-tauri
cargo build --release --features cli --bin gs_usb_cli
```

The binary will be at `target/release/gs_usb_cli`.

## Commands

### `list`

List all connected gs_usb devices.

```bash
gs_usb_cli list
```

### `probe`

Query a device for its capabilities (channel count, CAN FD support, hardware timestamps, etc.).

```bash
gs_usb_cli probe 0:5
gs_usb_cli probe 0:5 --serial ABC123
```

### `topology`

Display the USB descriptor hierarchy for a device (configurations, interfaces, endpoints).

```bash
gs_usb_cli topology 0:5
```

### `receive`

Receive CAN frames with per-transfer diagnostics. Useful for measuring frame loss and timing accuracy.

```bash
# Basic receive at 500 kbps
gs_usb_cli receive 0:5

# Listen-only mode (no ACK), 250 kbps, stop after 100 frames
gs_usb_cli receive 0:5 --bitrate 250000 --listen-only --count 100

# Custom sample point and clock override
gs_usb_cli receive 0:5 --sample-point 75.0 --can-clock 48000000
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--bitrate` | 500000 | CAN bitrate in bps |
| `--channel` | 0 | CAN channel (usually 0) |
| `--listen-only` | off | Enable listen-only mode (no ACK) |
| `--count` | unlimited | Stop after N frames |
| `--serial` | - | Match device by serial number |
| `--sample-point` | 87.5 | Sample point percentage |
| `--can-clock` | - | Override CAN clock frequency in Hz |

### `send`

Send a single CAN frame.

```bash
# Send standard frame: ID 0x100, data DEADBEEF
gs_usb_cli send 0:5 100 DEADBEEF

# Send extended (29-bit) frame at 250 kbps
gs_usb_cli send 0:5 1ABCDEF CAFE --extended --bitrate 250000
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--bitrate` | 500000 | CAN bitrate in bps |
| `--channel` | 0 | CAN channel |
| `--extended` | off | Send as extended (29-bit) frame |
| `--serial` | - | Match device by serial number |
| `--can-clock` | - | Override CAN clock frequency in Hz |

## Device Addressing

Devices are addressed by `bus:addr` (e.g., `0:5`). Use `gs_usb_cli list` to find connected devices and their addresses.

Alternatively, use `--serial` to match by serial number instead of bus address. This is more stable across reconnections.

# Supported Hardware

WireTAP supports a variety of CAN interfaces and data sources across all major platforms.

## Live CAN Hardware

### GVRET Devices (USB & TCP)

| Device | Interface | Platform | TX Support |
|--------|-----------|----------|------------|
| ESP32-RET | USB Serial | All | Yes |
| M2RET (Macchina M2) | USB Serial | All | Yes |
| CANDue | USB Serial | All | Yes |

**GVRET** (Generalized Vehicle Reverse Engineering Tool) is a protocol developed for the SavvyCAN project. These devices connect via USB serial or can be accessed remotely over TCP.

**Setup:** Create a **GVRET USB (Serial)** or **GVRET TCP** profile in Settings. GVRET TCP defaults to port 23.

**Links:**
- ESP32-RET: https://github.com/collin80/ESP32RET
- M2RET: https://github.com/collin80/M2RET

### CANable / CANable Pro

| Device | Firmware | Protocol | Platform | TX Support |
|--------|----------|----------|----------|------------|
| CANable | SLCAN | slcan | All | Yes |
| CANable | Candlelight | gs_usb | All | Yes |
| CANable Pro | SLCAN | slcan | All | Yes |
| CANable Pro | Candlelight | gs_usb | All | Yes |

Popular USB-to-CAN adapters supporting two firmware options. gs_usb is the recommended one: it is faster, has hardware timestamps and needs no serial port settings. For flashing, [Elmue's CANable 2.5 firmware](https://github.com/Elmue/CANable-2.5-firmware-Slcan-and-Candlelight) is recommended; it is maintained and offers both slcan and candleLight modes, whereas upstream candleLight is no longer actively developed. See [CANable Setup](canable-setup.md) for detailed flashing instructions.

**Setup:** Create an **slcan** or **gs_usb** profile depending on firmware (on Linux, a **SocketCAN** profile for gs_usb).

**Links:**
- CANable: https://canable.io/
- Firmware: https://github.com/Elmue/CANable-2.5-firmware-Slcan-and-Candlelight

### Other gs_usb Compatible Devices

Any device running candleLight/gs_usb firmware works with WireTAP:

| Device | Notes |
|--------|-------|
| USB2CAN | Chinese clone devices |
| CANtact | Original gs_usb device |
| candleLight | Reference implementation |
| CANable clones | Various manufacturers |

**Setup:** Create a **gs_usb** profile (Windows/macOS) or **SocketCAN** profile (Linux).

### SocketCAN (Linux Only)

| Interface Type | Examples |
|----------------|----------|
| Native CAN | Built-in CAN controllers |
| USB-CAN | gs_usb devices, PEAK-USB (kernel driver) |
| Virtual CAN | vcan0 for testing |
| CAN-over-network | slcand, cannelloni |

Linux's native CAN subsystem supports many hardware interfaces.

**Prerequisites:**
```bash
# Load kernel modules
sudo modprobe can
sudo modprobe can_raw

# Bring up interface
sudo ip link set can0 up type can bitrate 500000
```

**Setup:** Create a **SocketCAN** profile with the interface name (default `can0`). Leave the bitrate empty to use the interface as the system configured it, or set one and WireTAP configures the interface when the session starts, asking for your password.

PEAK adapters are not supported directly by the app on Windows or macOS; on Linux they work through SocketCAN. (`wiretap-can-cli`, which ships with WireTAP, can drive a PEAK PCAN-USB on Windows and macOS.)

### Serial Devices

Generic serial ports for custom protocols:

| Framing | Use Case |
|----------|----------|
| None (Raw) | Unframed serial data |
| SLIP | RFC 1055 framing |
| Modbus RTU | Industrial devices |
| Delimiter | Custom framing |

**Setup:** Create a **Serial Port** profile with port and baud rate (default 115200, 8N1). Framing is chosen per session in the data source picker.

### Other Live Sources

| Source | Profile | Notes |
|--------|---------|-------|
| FrameLink devices | **FrameLink** | Wired Square devices streaming CAN and RS-485 over TCP (default port 120). Supports transmit |
| Modbus TCP | **Modbus TCP** | Polls registers from a Modbus TCP device (default port 502, unit 1) |
| Virtual Adapter | **Virtual Adapter (Testing)** | Generates CAN, CAN FD, Modbus or serial traffic for testing without hardware; loopback echoes transmitted frames |

## Data Sources (Replay/Historical)

### WireTAP Backend

Replay and query CAN (or Modbus RTU) data archived by a WireTAP backend gateway:
- Time-range playback over the gateway's HTTP API
- Speed-controlled playback
- Queries run on the gateway (see [Query](query.md))

WireTAP doesn't connect to the database itself: the gateway owns it, and the app authenticates with an API key. Older PostgreSQL profiles are removed on upgrade.

**Requirements:** A WireTAP backend gateway and an API key with the `read` role. See [WireTAP Server](wiretap-server.md).

**Setup:** Create a **WireTAP Backend** profile with the backend URL (default `http://localhost:8423`), API key and capture database (default `wiretap`).

### CSV and candump Files

Import frames from files:
- GVRET/SavvyCAN CSV, with column mapping for other layouts
- Linux can-utils candump logs
- Several files at once, with sequence-gap reporting

**Setup:** No profile needed. In the data source picker, choose **CSV, CAN Dump** → **Import from file**.

### MQTT

Subscribe to CAN frames published via MQTT:
- Broker connection (default `localhost:1883`)
- Topic subscriptions
- JSON or SavvyCAN-format messages, including CAN FD

**Setup:** Create an **MQTT** profile with broker details and topic patterns.

### Captures

Every session records what it receives into a capture:
- Kept after the session stops, for replay, export and analysis
- Speed control and scrubbing
- Pin a capture to keep it across restarts, or send it to a WireTAP backend

Captures are listed on the **Captures** tab of the data source picker. See [Sessions](sessions.md).

## Platform Compatibility Matrix

| Device/Source | Windows | macOS | Linux |
|---------------|---------|-------|-------|
| GVRET USB | ✅ | ✅ | ✅ |
| GVRET TCP | ✅ | ✅ | ✅ |
| slcan | ✅ | ✅ | ✅ |
| gs_usb (native) | ✅ | ✅ | ❌* |
| SocketCAN | ❌ | ❌ | ✅ |
| FrameLink | ✅ | ✅ | ✅ |
| Serial | ✅ | ✅ | ✅ |
| Modbus TCP | ✅ | ✅ | ✅ |
| Virtual Adapter | ✅ | ✅ | ✅ |
| WireTAP Backend | ✅ | ✅ | ✅ |
| CSV / candump import | ✅ | ✅ | ✅ |
| MQTT | ✅ | ✅ | ✅ |

*On Linux, gs_usb devices use SocketCAN instead.

## Bitrate Support

### Standard CAN Bitrates

| Bitrate | slcan | gs_usb | SocketCAN |
|---------|-------|--------|-----------|
| 10 Kbps | ✅ | ✅ | ✅ |
| 20 Kbps | ✅ | ✅ | ✅ |
| 50 Kbps | ✅ | ✅ | ✅ |
| 100 Kbps | ✅ | ✅ | ✅ |
| 125 Kbps | ✅ | ✅ | ✅ |
| 250 Kbps | ✅ | ✅ | ✅ |
| 500 Kbps | ✅ | ✅ | ✅ |
| 750 Kbps | ✅ | ✅ | ✅ |
| 1 Mbps | ✅ | ✅ | ✅ |

### CAN FD

CAN FD (Flexible Data-rate) is supported on:
- SocketCAN interfaces with FD-capable hardware
- GVRET devices with FD support
- gs_usb devices with FD firmware
- slcan devices running Elmue's CANable firmware with CAN FD
- FrameLink devices with CAN FD interfaces

Data-phase bitrates run from 1 to 8 Mbit/s (500 kbit/s to 8 Mbit/s on slcan).

CAN FD allows:
- Data payloads up to 64 bytes
- Higher data-phase bitrates
- Improved efficiency

## Transmission Support

Not all configurations support transmitting frames:

| Configuration | TX Support |
|---------------|------------|
| GVRET USB/TCP | ✅ |
| slcan (normal mode) | ✅ |
| slcan (silent mode) | ❌ |
| gs_usb (normal mode) | ✅ |
| gs_usb (listen-only mode) | ❌ |
| SocketCAN | ✅ |
| FrameLink | ✅ |
| Serial Port | ✅ (raw bytes) |
| Virtual Adapter | ✅ |
| Modbus TCP | ❌ |
| WireTAP Backend | ❌ |
| CSV / candump import | ❌ |
| MQTT | ❌ |

New slcan and gs_usb profiles start in silent / listen-only mode, the safe choice on a vehicle bus; turn it off in the profile to transmit.

## Recommended Hardware

### For Beginners

**CANable Pro with SLCAN firmware**
- Works on all platforms out of the box
- Simple serial interface
- Affordable and widely available

### For Professional Use

**CANable Pro with candleLight (gs_usb) firmware**
- Higher performance
- Hardware timestamps
- Better error handling
- No serial port or baud rate to configure

### For Linux Users

**Any gs_usb device with SocketCAN**
- Native kernel support
- Best performance
- Full feature set

### For Remote Capture

**Raspberry Pi with WireTAP Server**
- Capture from remote locations
- Multiple CAN interfaces
- Optional archiving to a WireTAP backend gateway, for later replay and queries

See [WireTAP Server](wiretap-server.md) for setup instructions.

## See Also

- [CANable Setup](canable-setup.md) - Firmware flashing guide
- [Settings](settings.md#io-profiles) - Creating IO profiles
- [WireTAP Server](wiretap-server.md) - Remote capture setup

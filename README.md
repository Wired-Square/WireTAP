# WireTAP

A modern cross-platform tool for reverse engineering frame based protocols like CAN bus, MODBUS and serial.

Formerly known as CANdor.

## Features

- **Frame Discovery** - Capture and analyze CAN frames from multiple data sources
- **Signal Decoding** - Decode CAN signals using TOML-based catalog definitions
- **Catalog Editor** - Visual editor for creating and editing CAN frame/signal catalogs
- **Frame Transmission** - Send CAN frames with repeat/scheduling support
- **Multi-Protocol Support** - CAN, CAN FD, serial protocols, Modbus

## Documentation

See the [Wiki](../../wiki) for detailed documentation:

- [Installation](../../wiki/Installation) - Download and setup instructions
- [Getting Started](../../wiki/Home) - Overview and quick start guide
- [Supported Hardware](../../wiki/Supported-Hardware) - Compatible CAN interfaces
- [CANable Setup](../../wiki/CANable-Setup) - Firmware flashing guide

## Supported Hardware

| Device | Protocol | Platform |
|--------|----------|----------|
| ESP32-RET, M2RET, CANDue | GVRET (USB/TCP) | All |
| CANable, CANable Pro | gs_usb | All |
| CANable, CANable Pro | slcan | All |
| Native CAN interfaces | SocketCAN | Linux |

### CANable/CANable Pro: gs_usb vs slcan

CANable and CANable Pro devices support two firmware options that determine which protocol they use:

- **gs_usb** (candleLight firmware) — The device presents itself as a native USB CAN adapter using the gs_usb protocol. The host communicates directly over USB using raw packets, with no serial port involved. WireTAP talks to the device via [nusb](https://github.com/kevinmehall/nusb), a cross-platform userspace USB library.

- **slcan** (serial/LAWICEL firmware) — The device appears as a virtual serial port. CAN frames are exchanged as ASCII text commands over the serial link using the LAWICEL/slcan protocol.

**gs_usb is the recommended protocol** for several reasons:

1. **Higher throughput** — Binary USB transfers avoid the overhead of ASCII encoding/decoding each frame, so gs_usb sustains higher bus loads without dropping frames.
2. **Hardware timestamping** — gs_usb devices can provide hardware-level timestamps, giving more accurate frame timing than serial-based timestamps.
3. **No serial port configuration** — There's no baud rate, flow control, or COM port selection to get wrong. The device is detected automatically over USB.
4. **CAN FD support** — The CANable Pro with candleLight firmware supports CAN FD natively via gs_usb. slcan has no standard CAN FD extension.
5. **Cross-platform without drivers** — WireTAP's nusb integration means gs_usb works on macOS, Windows, and Linux without installing platform-specific drivers. On Linux, gs_usb devices also appear as native SocketCAN interfaces.

To use gs_usb, flash your CANable with [candleLight firmware](https://github.com/candle-usb/candleLight_fw). See the [CANable Setup](../../wiki/CANable-Setup) wiki page for flashing instructions.

## Data Sources

- Live CAN hardware (GVRET, slcan, gs_usb, SocketCAN)
- PostgreSQL database (historical replay with speed control)
- CSV file import
- In-memory buffer replay

## Tools

### [WireTAP Server](tools/wiretap-server/)

A GVRET-compatible TCP server for Linux that bridges SocketCAN interfaces to TCP clients. Deploy on a Raspberry Pi or any Linux system with CAN hardware to:

- Stream live CAN data to the WireTAP desktop app over the network
- Optionally log all frames to PostgreSQL for historical analysis
- Support multiple CAN interfaces and CAN FD

See [tools/wiretap-server/README.md](tools/wiretap-server/README.md) for setup instructions.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Zustand, Tailwind CSS
- **Backend**: Tauri 2 (Rust)
- **UI**: Dockview panels, Radix UI, Lucide icons

## Development

```bash
# Install dependencies
npm install

# Run tests
npm run test:watch

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build

# Clean build artifacts
rm -rf node_modules/.vite dist src-tauri/target
```

## License

MIT

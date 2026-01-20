# CANdor

A desktop application for CAN bus analysis and signal decoding, built with Tauri, React, and TypeScript.

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
| CANable, CANable Pro | slcan | All |
| Native CAN interfaces | SocketCAN | Linux |

## Data Sources

- Live CAN hardware (GVRET, slcan, SocketCAN)
- PostgreSQL database (historical replay with speed control)
- CSV file import
- In-memory buffer replay

## Tools

### [CANdor Server](tools/candor-server/)

A GVRET-compatible TCP server for Linux that bridges SocketCAN interfaces to TCP clients. Deploy on a Raspberry Pi or any Linux system with CAN hardware to:

- Stream live CAN data to the CANdor desktop app over the network
- Optionally log all frames to PostgreSQL for historical analysis
- Support multiple CAN interfaces and CAN FD

See [tools/candor-server/README.md](tools/candor-server/README.md) for setup instructions.

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

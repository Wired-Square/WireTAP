# WireTAP User Guide

WireTAP is a desktop application for reverse engineering frame-based protocols
such as CAN, CAN FD, Modbus and serial. It captures and decodes traffic from
many hardware interfaces and data sources.

## What is WireTAP?

You can use WireTAP to reverse engineer an automotive network, debug an
embedded system or develop a CAN-based protocol. It captures traffic, decodes
it against a catalogue of frames and signals, and helps you work out what the
bytes mean.

## Key features

- **Multi-source capture**: live CAN hardware, a WireTAP backend's archive,
  CSV files, or an in-memory buffer
- **Signal decoding**: decode frames live against TOML catalogues, which can
  be imported from DBC
- **Catalogue editing**: a tree editor, with raw TOML editing beside it
- **Frame transmission**: send single frames, schedule repeats, or replay
  captured traffic with its original timing
- **Analysis tools**: find changing bits, measure message timing and discover
  frame patterns
- **Cross-platform**: Windows, macOS and Linux

## Getting started

1. [Download and install WireTAP](installation.md)
2. [Set up your hardware](supported-hardware.md)
3. [Configure your first IO profile](settings.md#io-profiles)
4. [Start capturing frames](discovery.md)

## Contents

### Apps

| Page | Description |
|------|-------------|
| [Discovery](discovery.md) | Capture and explore raw CAN and serial frames |
| [Decoder](decoder.md) | Decode signals using catalogue definitions |
| [Transmit](transmit.md) | Send CAN frames to your network |
| [Dashboard](dashboard.md) | Show decoded signals as charts, gauges and lists |
| [Query](query.md) | Query and replay archived traffic from a WireTAP backend |
| [Catalog Editor](catalog-editor.md) | Create and edit signal catalogues |
| [Calculator](calculator.md) | Binary and hex conversion and analysis tools |
| [Sessions](sessions.md) | Monitor and control active IO sessions |
| [Settings](settings.md) | Configure profiles, directories and display options |

Events, Test Pattern, Rules and Serial have no pages yet.

### Hardware and setup

| Page | Description |
|------|-------------|
| [Supported Hardware](supported-hardware.md) | Compatible CAN interfaces and data sources |
| [CANable Setup](canable-setup.md) | Firmware flashing and configuration for CANable devices |
| [WireTAP Server](wiretap-server.md) | Remote capture and the backend archive |

## Supported platforms

| Platform | Builds |
|----------|--------|
| Windows 10/11 | x64 |
| macOS 13+ | Apple silicon and Intel |
| Linux (Ubuntu 22.04+) | x64 and arm64 |

## Getting help

Report problems and ask questions on
[GitHub Issues](https://github.com/Wired-Square/WireTAP/issues). If you'd like
to contribute, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

*WireTAP is open-source software, released under the MIT licence.*

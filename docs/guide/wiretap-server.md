# WireTAP Server

WireTAP Server is the capture side of WireTAP that runs on your network rather than your desktop. It has two programs, which live in the separate [WireTAP-Server](https://github.com/Wired-Square/WireTAP-Server) repository:

- **`wiretap-server`** - a GVRET-compatible TCP server that bridges Linux SocketCAN interfaces to TCP clients, enabling remote CAN capture from devices like Raspberry Pi, and forwards what it captures to a gateway for archiving
- **`wiretap-backend`** - the gateway. It owns a TimescaleDB database and is the only thing that talks to it, serving an HTTP query API for the desktop app, a binary ingest listener and a browser admin UI

<!-- Screenshot: Raspberry Pi with CAN HAT -->

## Overview

Deploy `wiretap-server` on a Raspberry Pi or any Linux system with CAN hardware to:
- Stream live CAN data to the WireTAP desktop app over the network
- Archive frames to a WireTAP backend gateway for historical analysis
- Support multiple CAN interfaces and CAN FD

The server is a read-only tap. The one exception is the Test Pattern responder, which transmits and is off unless you enable it.

## Features

- **GVRET Protocol** - Compatible with SavvyCAN and WireTAP
- **Multi-bus Support** - Bridge multiple CAN interfaces simultaneously
- **Gateway Forwarding** - Batch frames to a WireTAP backend, with a disk cache that carries a gateway outage
- **Serial Capture** - Tap a serial line (Modbus RTU) read-only, alongside CAN
- **CAN FD Support** - Handle payloads up to 64 bytes
- **Kernel Timestamps** - Accurate frame timing via SO_TIMESTAMP

## Hardware Requirements

- **Computer:** Raspberry Pi (any model), or Linux system with systemd
- **CAN Interface:** USB adapter or HAT/SPI board

### Supported CAN Hardware

| Type | Examples |
|------|----------|
| **USB** | CANable, CANable Pro, PEAK PCAN-USB |
| **HAT/SPI** | Waveshare RS485 CAN HAT, PiCAN, MCP2515-based boards |

## Quick Start

### 1. Install the Package

Download `wiretap-server_<version>_<arch>.deb` (arm64 or amd64) from the [WireTAP-Server releases](https://github.com/Wired-Square/WireTAP-Server/releases) and install it:

```bash
sudo apt install ./wiretap-server_<version>_arm64.deb
```

The package is a static build that installs on any distribution with systemd. It installs the `wiretap-server` service (enabled), the `wiretap-can@` units that bring CAN interfaces up, and an annotated config at `/etc/wiretap-server/wiretap-server.toml`. A web UI for the daemon is a second package, `wiretap-server-ui`. The repository's README also covers running it under Docker.

### 2. Configure the CAN Interface

The server opens an interface that is already up. The package brings one up from a file naming its bitrate:

```bash
sudo cp /usr/share/doc/wiretap-server/examples/can0.conf /etc/wiretap-server/can.d/
sudo nano /etc/wiretap-server/can.d/can0.conf    # BITRATE, and DBITRATE for CAN FD
```

#### USB Adapters (CANable, etc.)

A candleLight or CANable adapter (`gs_usb`) with a file in `can.d` is brought up whenever it is plugged in.

```bash
# Verify
ip -details link show can0
```

#### SPI/HAT Adapters (MCP2515)

Add to `/boot/firmware/config.txt`:
```ini
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25
dtoverlay=spi-bcm2835-overlay
```

Then reboot and enable the interface once:
```bash
sudo reboot
sudo systemctl enable --now wiretap-can@can0
```

#### CAN FD Interfaces

Set `DBITRATE` in the interface's `can.d` file (setting it turns FD on), and set `can_fd = true` in the server's config.

#### Verify with candump

```bash
candump can0
```

You should see frames like:
```
can0  7DF   [8]  02 01 00 00 00 00 00 00
can0  7E8   [8]  06 41 00 BE 3F A8 13 00
```

### 3. Configure wiretap-server

Edit the installed config. Every key is commented out, and the defaults capture `can0`:

```bash
sudo nano /etc/wiretap-server/wiretap-server.toml
```

Key settings:
```toml
[server]
iface = "can0"          # CAN interface(s), comma-separated
host = "0.0.0.0"        # GVRET listen address
port = 23               # GVRET port; the packaged unit grants the right to bind it
allowed_clients = ["127.0.0.0/8", "192.168.1.0/24"]
                        # who may connect over GVRET; loopback only by default
can_fd = false          # Set true for CAN FD

[forward]
enable = true           # archive to a WireTAP backend gateway
host = "gateway.local"
port = 9323
```

**Add the network your desktop connects from to `allowed_clients`.** GVRET has no password and can transmit on every active bus, so by default only the Pi itself may connect.

Values in the config file override command-line flags, not the other way round. `wiretap-server --check-config -C /etc/wiretap-server/wiretap-server.toml` prints what a configuration resolves to.

### 4. Run the Server

```bash
sudo systemctl restart wiretap-server
```

To run it by hand instead:

```bash
# Basic usage
wiretap-server -C my-config.toml

# With console echo for debugging
wiretap-server -C my-config.toml --echo-console

# Multiple interfaces
wiretap-server --iface can0,can1
```

Press `Ctrl+C` to stop.

## Automatic Startup (systemd)

The package installs and enables the services, so there are no unit files to copy.

### 1. Bring Up Interfaces

A gs_usb adapter with a `can.d` file comes up when plugged in. For anything else (a HAT, for one), enable its interface unit once:

```bash
sudo systemctl enable --now wiretap-can@can0
```

A unit made from the old `can-interface.service` example is left alone by the package; disable it once `wiretap-can@` has taken over its interface.

### 2. Keep Secrets Out of the Config

Put the gateway API key in `/etc/wiretap-server/env`, which need not be world-readable:

```bash
WIRETAP_FORWARD_TOKEN=<api key with the ingest role>
```

### 3. Check Status

```bash
sudo systemctl status wiretap-server.service
sudo journalctl -u wiretap-server.service -f
```

## Connecting from WireTAP Desktop

### Live, over GVRET

1. Open WireTAP Settings
2. Create a new IO Profile:
   - **Type:** GVRET TCP
   - **Host:** Raspberry Pi IP address (e.g., `192.168.1.100`)
   - **Port:** `23` (or the port the server listens on)
3. Open Discovery or Decoder and pick the profile in the data source picker
4. Click **Connect** to begin streaming

### Archived, through the gateway

1. Create a new IO Profile:
   - **Type:** WireTAP Backend
   - **Backend URL:** the gateway's HTTP address (e.g., `http://gateway.local:8423`)
   - **API Key:** a key with the `read` role
   - **Capture Database:** the database the server forwards to
2. Pick it in Discovery, Decoder or [Query](query.md) to replay or query the archive

WireTAP never connects to the database directly; the gateway owns it.

## Gateway Setup (Optional)

Archiving needs a `wiretap-backend` gateway: a Docker stack of TimescaleDB and the gateway, on the Pi or another Docker host. The deployment in the WireTAP-Server repository's `crates/wiretap-backend/deploy/` runs the released image, `ghcr.io/wired-square/wiretap-backend` (amd64 and arm64); its README has the full steps. In short:

```bash
cd crates/wiretap-backend/deploy
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, WIRETAP_ADMIN_KEY (openssl rand -hex 32) and the image tag
docker compose up -d
curl -fsS http://localhost:8423/v1/health
```

The gateway serves its HTTP API and admin UI on port 8423, and takes frames from servers on port 9323.

Then open `http://<gateway>:8423/admin`, sign in with the admin key, and create:
- an `ingest` key for each `wiretap-server`, optionally pinned to one database
- a `read` key for each desktop user

The default capture database, `wiretap`, is created on first start.

### Configure Server

Point the server's `[forward]` at the gateway:
```toml
[forward]
enable = true
host = "gateway.local"
port = 9323
database = "wiretap"
batch_size = 500
flush_interval = 0.5
```

The old `[postgres]` section is gone: `[postgres] enable = true` is refused, because the server no longer writes to PostgreSQL.

## Troubleshooting

### No CAN Interface Found

```bash
# Check interface
ip link show type can

# Check the interface unit
sudo systemctl status wiretap-can@can0

# Load kernel modules
sudo modprobe can
sudo modprobe can_raw
sudo modprobe gs_usb  # For USB adapters
```

### Permission Denied on Port 23

The packaged unit grants `CAP_NET_BIND_SERVICE`. When running by hand, use a high port (`--port 2323`) or run it under the unit.

### Connection Refused from WireTAP

```bash
# Check server status
sudo systemctl status wiretap-server.service

# Check port
sudo ss -tlnp | grep ':23 '

# Check firewall
sudo ufw allow 23/tcp
```

If the port is open but the desktop is turned away, add its network to `allowed_clients` in `[server]`.

## Command Line Reference

```
wiretap-server [-h] [-C CONFIG] [--iface IFACE] [--host HOST] [--port PORT]
               [--allowed-clients CIDRS] [--echo-console] [--can-fd]
               [--forward-enable] [--forward-host HOST] [--forward-api-key KEY]
               [--forward-database DB] [--check-config] [--log-level LEVEL]
```

| Option | Description |
|--------|-------------|
| `-C CONFIG` | Path to TOML config file (its values override flags) |
| `--iface` | CAN interface(s), comma-separated; `""` for no CAN hardware |
| `--host` | GVRET listen address |
| `--port` | GVRET listen port (default 23) |
| `--allowed-clients` | CIDR ranges allowed to connect over GVRET (default loopback only) |
| `--echo-console` | Echo frames to console in candump format |
| `--can-fd` | Enable CAN FD support |
| `--forward-enable` | Forward frames to a WireTAP backend gateway |
| `--forward-host`, `--forward-port` | Gateway ingest address (port 9323) |
| `--forward-api-key` | Gateway API key, or `WIRETAP_FORWARD_TOKEN` |
| `--forward-database` | Target capture database |
| `--check-config` | Print what the configuration resolves to, and exit |
| `--log-level` | DEBUG, INFO, WARNING, ERROR |

`wiretap-server --help` lists the rest, including the ingest listener and the Test Pattern responder.

## See Also

- [Supported Hardware](supported-hardware.md) - Compatible CAN interfaces
- [Settings](settings.md#gvret-tcp) - Creating GVRET TCP profiles
- [Discovery](discovery.md) - Start capturing data
